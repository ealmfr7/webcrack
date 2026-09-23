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
  "src/dep.js"(exports, module2) {
    module2.exports = function add2(a, b) {
      return a + b;
    };
  }
});

// src/main.js
var add = require_dep();
console.log(add(1, 2));
