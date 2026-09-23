var __defProp = Object.defineProperty;
var __export = (target, all) => {
  for (var name in all)
    __defProp(target, name, { get: all[name], enumerable: true });
};

// src/math.js
function add(a, b) {
  return a + b;
}

// src/index.js
__export({}, {
  add: () => add,
  default: () => index_default
});
var index_default = add(1, 2);
console.log(index_default);
