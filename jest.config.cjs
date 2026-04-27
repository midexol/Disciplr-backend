module.exports = {
  testEnvironment: 'node',

  transform: {
    '^.+\\.ts$': [
      'ts-jest',
      {
        tsconfig: {
          module: 'commonjs',
        },
      },
    ],
  },

  moduleFileExtensions: ['ts', 'js', 'json'],

  testMatch: [
    '**/src/tests/**/*.test.ts',
    '**/src/tests/**/*.test.js',
  ],

  moduleNameMapper: {
    '^(\\.{1,2}/.*)\\.js$': '$1',
  },
}