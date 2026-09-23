(() => {
  var __webpack_modules__ = {
    1: (module, exports, require) => {
      const greet = require(2);
      const lazy = require(10);
      console.log(greet, lazy);
    },
    2: (module, exports) => {
      module.exports = 'hello';
    },
  };
  var installedModules = {};
  function __webpack_require__(moduleId) {
    var cached = installedModules[moduleId];
    if (cached !== undefined) {
      return cached.exports;
    }
    var module = (installedModules[moduleId] = {
      id: moduleId,
      loaded: false,
      exports: {},
    });
    __webpack_modules__[moduleId].call(
      module.exports,
      module,
      module.exports,
      __webpack_require__
    );
    module.loaded = true;
    return module.exports;
  }
  var entryModule = __webpack_require__((__webpack_require__.s = 1));
  module.exports = entryModule;
})();
