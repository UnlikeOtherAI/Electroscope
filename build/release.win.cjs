const { build } = require('../package.json');

module.exports = {
  ...build,
  forceCodeSigning: true,
  win: {
    ...build.win,
    signtoolOptions: {
      sign: 'scripts/sign-windows.cjs',
      signingHashAlgorithms: ['sha256'],
      publisherName: 'UnlikeOtherAI s.r.o.',
    },
  },
  nsis: { ...build.nsis, artifactName: 'Electroscope-Windows-x64-Setup.${ext}' },
  portable: { artifactName: 'Electroscope-Windows-x64-Portable.${ext}' },
};
