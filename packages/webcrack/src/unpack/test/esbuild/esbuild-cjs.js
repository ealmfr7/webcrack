"use strict";
var __defProp = Object.defineProperty;
var __getOwnPropDesc = Object.getOwnPropertyDescriptor;
var __getOwnPropNames = Object.getOwnPropertyNames;
var __hasOwnProp = Object.prototype.hasOwnProperty;
var __copyProps = (to, from, except, desc) => {
  if (from && typeof from === "object" || typeof from === "function") {
    for (let key of __getOwnPropNames(from))
      if (!__hasOwnProp.call(to, key) && key !== except)
        __defProp(to, key, { get: () => from[key], enumerable: !(desc = __getOwnPropDesc(from, key)) || desc.enumerable });
  }
  return to;
};
var __toESM = (mod, isNodeMode, target) => (target = mod != null ? {} : {}, __copyProps(
  isNodeMode || !mod || !mod.__esModule ? __defProp(target, "default", { value: mod, enumerable: true }) : target,
  mod
));
var __commonJS = (cb, mod) => function __require() {
  return mod || (0, cb[__getOwnPropNames(cb)[0]])((mod = { exports: {} }).exports, mod), mod.exports;
};

// src/math.js
var require_math = __commonJS({
  "src/math.js"(exports, module) {
    function add(a, b) {
      return a + b;
    }
    function sub(a, b) {
      return a - b;
    }
    module.exports = { add, sub };
  }
});

// src/greet.js
var require_greet = __commonJS({
  "src/greet.js"(exports, module) {
    var import_math = __toESM(require_math());
    function greet(name) {
      return "Hello, " + name + "! 1 + 2 = " + import_math.add(1, 2);
    }
    module.exports = greet;
  }
});

// src/index.js
var require_index = __commonJS({
  "src/index.js"(exports, module) {
    var import_greet = __toESM(require_greet());
    var fs = __require("fs");
    console.log((0, import_greet.default)("world"));
  }
});
require_index();
