(function (global) {
  var $parcel$global = global;
  function $parcel$defineInteropFlag(a) {
    Object.defineProperty(a, '__esModule', { value: true });
  }
  function $parcel$export(e, n, v, s) {
    Object.defineProperty(e, n, { get: v, set: s, enumerable: true, configurable: true });
  }
  function $parcel$interopDefault(a) {
    return a && a.__esModule ? a.default : a;
  }
  var $parcel$modules = {};
  function parcelRequire(id) {
    var module = $parcel$modules[id];
    if (!module) throw new Error("Cannot find module '" + id + "'");
    if (!module.exports) {
      module.factory(module, (module.exports = {}));
    }
    return module.exports;
  }
  function parcelRegister(id, factory) {
    $parcel$modules[id] = { factory: factory, exports: null };
  }
  parcelRegister('entry1hash', function (module, exports) {
    var _add = parcelRequire('addhash');
    var _color = $parcel$interopDefault(parcelRequire('colorhash'));
    module.exports = function main() {
      return (0, _add.add)(1, 2) + ' ' + _color;
    };
  });
  parcelRegister('addhash', function (module, exports) {
    $parcel$defineInteropFlag(exports);
    $parcel$export(exports, 'add', function () {
      return add;
    });
    function add(a, b) {
      return a + b;
    }
  });
  parcelRegister('colorhash', function (module, exports) {
    module.exports = '#FBC02D';
  });
  parcelRequire('entry1hash');
})(typeof globalThis !== 'undefined' ? globalThis : this);
