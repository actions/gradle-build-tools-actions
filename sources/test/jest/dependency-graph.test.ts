import {describe, expect, it} from '@jest/globals'

import {DependencyGraphConfig} from "../../src/configuration" 
import {isRetryableError, getErrorStatusText} from "../../src/dependency-graph"

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
})
