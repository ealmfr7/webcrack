var __getOwnPropNames = Object.getOwnPropertyNames;
var __commonJS = (cb, mod) => function __require() {
  try {
    return mod || (0, cb[__getOwnPropNames(cb)[0]])((mod = { exports: {} }).exports, mod), mod.exports;
  } catch (e) {
    throw mod = 0, e;
  }
};

// src/dep.js
var require_dep = __commonJS({
  "src/dep.js"(exports, module) {
    module.exports = function add(a, b) {
      return a + b;
    };
  }
});

// src/main.js
var require_main = __commonJS({
  "src/main.js"(exports, module) {
    var add = require_dep();
    console.log(add(1, 2));
  }
});
require_main();
