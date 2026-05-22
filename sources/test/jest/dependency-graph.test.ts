import {beforeEach, afterEach, describe, expect, it, jest} from '@jest/globals'

import {DependencyGraphConfig} from '../../src/configuration' 
import {isRetryableError, getErrorStatusText, retryWithBackoff} from '../../src/dependency-graph'

function httpError(status: number, message: string): Error & {status: number} {
    return Object.assign(new Error(message), {name: 'HttpError', status})
}

describe('dependency-graph', () => {
    describe('constructs job correlator', () => {
        it('removes commas from workflow name', () => {
            const id = DependencyGraphConfig.constructJobCorrelator('Workflow, with,commas', 'jobid', '{}')
            expect(id).toBe('workflow_withcommas-jobid')
        })
        it('removes non word characters', () => {
            const id = DependencyGraphConfig.constructJobCorrelator('Workflow!_with()characters', 'job-*id', '{"foo": "bar!@#$%^&*("}')
            expect(id).toBe('workflow_withcharacters-job-id-bar')
        })
        it('replaces spaces', () => {
            const id = DependencyGraphConfig.constructJobCorrelator('Workflow !_ with () characters, and   spaces', 'job-*id', '{"foo": "bar!@#$%^&*("}')
            expect(id).toBe('workflow___with_characters_and_spaces-job-id-bar')
        })
        it('without matrix', () => {
            const id = DependencyGraphConfig.constructJobCorrelator('workflow', 'jobid', 'null')
            expect(id).toBe('workflow-jobid')
        })
        it('with dashes in values', () => {
            const id = DependencyGraphConfig.constructJobCorrelator('workflow-name', 'job-id', '{"os": "ubuntu-latest"}')
            expect(id).toBe('workflow-name-job-id-ubuntu-latest')
        })
        it('with single matrix value', () => {
            const id = DependencyGraphConfig.constructJobCorrelator('workflow', 'jobid', '{"os": "windows"}')
            expect(id).toBe('workflow-jobid-windows')
        })
        it('with composite matrix value', () => {
            const id = DependencyGraphConfig.constructJobCorrelator('workflow', 'jobid', '{"os": "windows", "java-version": "21.1", "other": "Value, with COMMA"}')
            expect(id).toBe('workflow-jobid-windows-211-value_with_comma')
        })
    })

    describe('isRetryableError', () => {
        it('returns true for HTTP 429 (rate limit)', () => {
            expect(isRetryableError(httpError(429, 'rate limit exceeded'))).toBe(true)
        })

        it('returns true for HTTP 500 (internal server error)', () => {
            expect(isRetryableError(httpError(500, 'Internal Server Error'))).toBe(true)
        })

        it('returns true for HTTP 502 (bad gateway)', () => {
            expect(isRetryableError(httpError(502, 'Bad Gateway'))).toBe(true)
        })

        it('returns true for HTTP 503 (service unavailable)', () => {
            expect(isRetryableError(httpError(503, 'Service Unavailable'))).toBe(true)
        })

        it('returns false for HTTP 403 (forbidden)', () => {
            expect(isRetryableError(httpError(403, 'Resource not accessible by integration'))).toBe(false)
        })

        it('returns false for HTTP 404 (not found)', () => {
            expect(isRetryableError(httpError(404, 'Not Found'))).toBe(false)
        })

        it('returns false for HTTP 422 (unprocessable entity)', () => {
            expect(isRetryableError(httpError(422, 'Validation Failed'))).toBe(false)
        })

        it('returns false for a plain Error without status', () => {
            expect(isRetryableError(new Error('network error'))).toBe(false)
        })

        it('returns false for non-Error values', () => {
            expect(isRetryableError('some string')).toBe(false)
            expect(isRetryableError(null)).toBe(false)
            expect(isRetryableError(undefined)).toBe(false)
        })
    })

    describe('getErrorStatusText', () => {
        it('returns status text for HttpError with status', () => {
            expect(getErrorStatusText(httpError(503, 'Server Error'))).toBe(' (HTTP 503)')
        })

        it('returns empty string for plain Error without status', () => {
            expect(getErrorStatusText(new Error('no status'))).toBe('')
        })

        it('returns empty string for non-Error values', () => {
            expect(getErrorStatusText('string')).toBe('')
            expect(getErrorStatusText(null)).toBe('')
        })
    })

    describe('retryWithBackoff', () => {
        const baseOptions = {
            maxAttempts: 3,
            baseDelayMs: 1000,
            isRetryable: isRetryableError
        }

        beforeEach(() => {
            jest.useFakeTimers()
        })

        afterEach(() => {
            jest.useRealTimers()
        })

        it('returns the result on first success without delay', async () => {
            const operation = jest.fn<() => Promise<string>>().mockResolvedValue('result')
            const onRetry = jest.fn()

            await expect(retryWithBackoff(operation, {...baseOptions, onRetry})).resolves.toBe('result')
            expect(operation).toHaveBeenCalledTimes(1)
            expect(onRetry).not.toHaveBeenCalled()
        })

        it('retries on a retryable error and returns the eventual result', async () => {
            const operation = jest.fn<() => Promise<string>>()
                .mockRejectedValueOnce(httpError(503, 'down'))
                .mockResolvedValueOnce('ok')
            const onRetry = jest.fn()

            const promise = retryWithBackoff(operation, {...baseOptions, onRetry})
            await jest.advanceTimersByTimeAsync(1000)

            await expect(promise).resolves.toBe('ok')
            expect(operation).toHaveBeenCalledTimes(2)
            expect(onRetry).toHaveBeenCalledTimes(1)
            expect(onRetry).toHaveBeenCalledWith(1, 1000, expect.any(Error))
        })

        it('uses exponential backoff between attempts', async () => {
            const operation = jest.fn<() => Promise<string>>()
                .mockRejectedValueOnce(httpError(500, 'fail'))
                .mockRejectedValueOnce(httpError(500, 'fail'))
                .mockResolvedValueOnce('ok')
            const onRetry = jest.fn()

            const promise = retryWithBackoff(operation, {...baseOptions, onRetry})
            await jest.advanceTimersByTimeAsync(1000) // first retry delay
            await jest.advanceTimersByTimeAsync(2000) // second retry delay

            await expect(promise).resolves.toBe('ok')
            expect(operation).toHaveBeenCalledTimes(3)
            expect(onRetry).toHaveBeenNthCalledWith(1, 1, 1000, expect.any(Error))
            expect(onRetry).toHaveBeenNthCalledWith(2, 2, 2000, expect.any(Error))
        })

        it('throws the last error after exhausting maxAttempts', async () => {
            const error = httpError(503, 'still down')
            const operation = jest.fn<() => Promise<string>>().mockRejectedValue(error)
            const onRetry = jest.fn()

            await Promise.all([
                expect(retryWithBackoff(operation, {...baseOptions, onRetry})).rejects.toBe(error),
                jest.advanceTimersByTimeAsync(3000) // 1000 + 2000
            ])

            expect(operation).toHaveBeenCalledTimes(3)
            expect(onRetry).toHaveBeenCalledTimes(2)
        })

        it('throws immediately on a non-retryable error', async () => {
            const error = httpError(404, 'not found')
            const operation = jest.fn<() => Promise<string>>().mockRejectedValue(error)
            const onRetry = jest.fn()

            await expect(retryWithBackoff(operation, {...baseOptions, onRetry})).rejects.toBe(error)
            expect(operation).toHaveBeenCalledTimes(1)
            expect(onRetry).not.toHaveBeenCalled()
        })
    })
})
