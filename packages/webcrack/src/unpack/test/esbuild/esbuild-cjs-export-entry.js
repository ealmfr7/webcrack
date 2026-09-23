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
  "src/dep.js"(exports2, module2) {
    module2.exports = function add(a, b) {
      return a + b;
    };
  }
});

// src/libmain.js
module.exports = require_dep();
