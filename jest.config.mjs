export default {
    transform: {},
    setupFiles: [
        '<rootDir>/tests/setup/global-home-mock.mjs',
        '<rootDir>/tests/setup/path-guard.mjs'
    ],
    globalTeardown: '<rootDir>/tests/setup/global-teardown.mjs',
    testMatch: [
        '**/tests/**/*.test.mjs'
    ],
    testTimeout: 15000,
    maxWorkers: 1,
    coveragePathIgnorePatterns: [
        '/node_modules/',
        'src/index.mjs'
    ]
}
