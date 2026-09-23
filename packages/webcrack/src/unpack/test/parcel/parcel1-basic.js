(function (modules, cache, entry, globalName) {
  function parcelRequire(id) {
    if (id in cache) return cache[id].exports;
    var module = (cache[id] = { exports: {} });
    modules[id][0].call(module.exports, parcelRequire, module, module.exports);
    return module.exports;
  }
  parcelRequire(entry[0]);
})({
  entry1: [
    function (require, module, exports) {
      var add = require('./utils/add');
      var color = require('./utils/color');
      module.exports = function main() {
        return add(1, 2) + ' ' + color;
      };
    },
    { './utils/add': 'dep1', './utils/color': 'dep2' },
  ],
  dep1: [
    function (require, module, exports) {
      module.exports = function add(a, b) {
        return a + b;
      };
    },
    {},
  ],
  dep2: [
    function (require, module, exports) {
      var add = require('./add');
      module.exports = add(40, 2);
    },
    { './add': 'dep1' },
  ],
},
{}, ['entry1'], null);
