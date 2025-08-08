module.exports = {
  clearMocks: true,
  moduleFileExtensions: ['js', 'ts', 'json'],
  testEnvironment: 'node',
  testMatch: ['**/*.test.ts'],
  transform: {
    '^.+\\.ts$': 'ts-jest'
  },
  reporters: process.env.CI === 'true' 
    ? ['default'] 
    : ['default', '@gradle/develocity-agent/jest-reporter'],
  verbose: true
}
