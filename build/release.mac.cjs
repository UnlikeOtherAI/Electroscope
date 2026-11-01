const { build } = require('../package.json');

module.exports = {
  ...build,
  forceCodeSigning: true,
  artifactName: 'Electroscope-macOS-arm64.${ext}',
  mac: {
    ...build.mac,
    identity: 'UnlikeOtherAI s.r.o. (23B7GTLBN7)',
    notarize: true,
  },
};
