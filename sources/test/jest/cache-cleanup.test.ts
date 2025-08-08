import * as exec from '@actions/exec'
import * as glob from '@actions/glob'
import fs from 'fs'
import path from 'path'
import {expect, test, jest} from '@jest/globals'

import {CacheCleaner} from '../../src/caching/cache-cleaner'

jest.setTimeout(120000)

test('will cleanup unused dependency jars and build-cache entries', async () => {
    const projectRoot = prepareTestProject()
    const gradleUserHome = path.resolve(projectRoot, 'HOME')
    const tmpDir = path.resolve(projectRoot, 'tmp')
    const cacheCleaner = new CacheCleaner(gradleUserHome, tmpDir)

    await runGradleBuild(projectRoot, 'build', '3.1')
    
    const timestamp = await cacheCleaner.prepare()

    await runGradleBuild(projectRoot, 'build', '3.1.1')

    const commonsMath31 = path.resolve(gradleUserHome, "caches/modules-2/files-2.1/org.apache.commons/commons-math3/3.1")
    const commonsMath311 = path.resolve(gradleUserHome, "caches/modules-2/files-2.1/org.apache.commons/commons-math3/3.1.1")
    const buildCacheDir = path.resolve(gradleUserHome, "caches/build-cache-1")

    expect(fs.existsSync(commonsMath31)).toBe(true)
    expect(fs.existsSync(commonsMath311)).toBe(true)
    expect(fs.readdirSync(buildCacheDir).length).toBe(4) // gc.properties, build-cache-1.lock, and 2 task entries

    await cacheCleaner.forceCleanupFilesOlderThan(timestamp, 'gradle')

    expect(fs.existsSync(commonsMath31)).toBe(false)
    expect(fs.existsSync(commonsMath311)).toBe(true)
    expect(fs.readdirSync(buildCacheDir).length).toBe(3) // 1 task entry has been cleaned up
})

test('will cleanup unused gradle versions', async () => {
    const projectRoot = prepareTestProject()
    const gradleUserHome = path.resolve(projectRoot, 'HOME')
    const tmpDir = path.resolve(projectRoot, 'tmp')
    const cacheCleaner = new CacheCleaner(gradleUserHome, tmpDir)

    // Initialize HOME with 2 different Gradle versions
    await runGradleWrapperBuild(projectRoot, 'build')
    await runGradleBuild(projectRoot, 'build')

    const timestamp = await cacheCleaner.prepare()

    // Run with only one of these versions
    await runGradleBuild(projectRoot, 'build')

    const gradle802 = path.resolve(gradleUserHome, "caches/8.0.2")
    const transforms3 = path.resolve(gradleUserHome, "caches/transforms-3")
    const metadata100 = path.resolve(gradleUserHome, "caches/modules-2/metadata-2.100")
    const wrapper802 = path.resolve(gradleUserHome, "wrapper/dists/gradle-8.0.2-bin")

    // Determine the current Gradle cache and metadata directories dynamically
    const gradleCurrentDirName = findCurrentGradleCacheVersionDir(gradleUserHome, '8.0.2')
    const gradleCurrent = path.resolve(gradleUserHome, "caches", gradleCurrentDirName)
    const metadataCurrent = path.resolve(gradleUserHome, "caches/modules-2", findLatestMetadataDir(gradleUserHome))

    expect(fs.existsSync(gradle802)).toBe(true)
    expect(fs.existsSync(transforms3)).toBe(true)
    expect(fs.existsSync(metadata100)).toBe(true)
    expect(fs.existsSync(wrapper802)).toBe(true)

    expect(fs.existsSync(gradleCurrent)).toBe(true)
    expect(fs.existsSync(metadataCurrent)).toBe(true)

    // The wrapper won't be removed if it was recently downloaded. Age it.
    setUtimes(wrapper802, new Date(Date.now() - 48 * 60 * 60 * 1000))

    await cacheCleaner.forceCleanupFilesOlderThan(timestamp, 'gradle')

    expect(fs.existsSync(gradle802)).toBe(false)
    expect(fs.existsSync(transforms3)).toBe(false)
    expect(fs.existsSync(metadata100)).toBe(false)
    expect(fs.existsSync(wrapper802)).toBe(false)

    expect(fs.existsSync(gradleCurrent)).toBe(true)
    expect(fs.existsSync(metadataCurrent)).toBe(true)
})

async function runGradleBuild(projectRoot: string, args: string, version: string = '3.1'): Promise<void> {
    await exec.exec(`gradle -g HOME --no-daemon --build-cache -Dcommons_math3_version="${version}" ${args}`, [], {
        cwd: projectRoot
    })
    console.log(`Gradle User Home initialized with commons_math3_version=${version} ${args}`)
}

async function runGradleWrapperBuild(projectRoot: string, args: string, version: string = '3.1'): Promise<void> {
    await exec.exec(`./gradlew -g HOME --no-daemon --build-cache -Dcommons_math3_version="${version}" ${args}`, [], {
        cwd: projectRoot
    })
    console.log(`Gradle User Home initialized with commons_math3_version="${version}" ${args}`)
}

function prepareTestProject(): string {
    const projectRoot = 'test/jest/resources/cache-cleanup'
    fs.rmSync(path.resolve(projectRoot, 'HOME'), { recursive: true, force: true })
    fs.rmSync(path.resolve(projectRoot, 'tmp'), { recursive: true, force: true })
    fs.rmSync(path.resolve(projectRoot, 'build'), { recursive: true, force: true })
    fs.rmSync(path.resolve(projectRoot, '.gradle'), { recursive: true, force: true })
    return projectRoot
}

async function setUtimes(pattern: string, timestamp: Date): Promise<void> {
    const globber = await glob.create(pattern)
    for await (const file of globber.globGenerator()) {
        fs.utimesSync(file, timestamp, timestamp)
    }
}

// Find the current Gradle cache version directory name (e.g., '8.14.2'), excluding a specific version if provided
function findCurrentGradleCacheVersionDir(gradleUserHome: string, excludeVersion?: string): string {
    const cachesDir = path.resolve(gradleUserHome, 'caches')
    const entries = fs.existsSync(cachesDir) ? fs.readdirSync(cachesDir, { withFileTypes: true }) : []
    const versionDirs = entries
        .filter(e => e.isDirectory() && /^\d+\.\d+(?:\.\d+)?$/.test(e.name) && e.name !== excludeVersion)
        .map(e => e.name)

    expect(versionDirs.length).toBeGreaterThan(0)

    versionDirs.sort(compareSemVer)
    return versionDirs[versionDirs.length - 1]
}

function compareSemVer(a: string, b: string): number {
    const pa = a.split('.').map(n => parseInt(n, 10))
    const pb = b.split('.').map(n => parseInt(n, 10))
    for (let i = 0; i < Math.max(pa.length, pb.length); i++) {
        const da = pa[i] || 0
        const db = pb[i] || 0
        if (da !== db) return da - db
    }
    return 0
}

// Find the latest metadata directory like 'metadata-2.107'
function findLatestMetadataDir(gradleUserHome: string): string {
    const modules2Dir = path.resolve(gradleUserHome, 'caches/modules-2')
    const entries = fs.existsSync(modules2Dir) ? fs.readdirSync(modules2Dir, { withFileTypes: true }) : []
    const metas = entries
        .filter(e => e.isDirectory() && /^metadata-2\.\d+$/.test(e.name))
        .map(e => e.name)

    expect(metas.length).toBeGreaterThan(0)

    metas.sort((a, b) => {
        const na = parseInt(a.split('.')[1], 10)
        const nb = parseInt(b.split('.')[1], 10)
        return na - nb
    })

    return metas[metas.length - 1]
}
