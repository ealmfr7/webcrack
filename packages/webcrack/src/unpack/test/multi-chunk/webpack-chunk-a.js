(self.webpackChunk_app = self.webpackChunk_app || []).push([
  [10],
  {
    10: function (module, exports, require) {
      const extra = require(11);
      module.exports = 'lazy:' + extra;
    },
  },
]);
