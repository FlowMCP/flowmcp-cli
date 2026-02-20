export default {
    transform: {},
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
