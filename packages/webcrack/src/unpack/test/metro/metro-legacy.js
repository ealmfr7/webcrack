__d(function (global, require, module, exports, dependencyMap) {
  "use strict";
  const value = require(dependencyMap[0]);
  module.exports = value + 1;
}, 10, [11], "legacy/entry.js");
__d(function (global, require, importDefault, module, exports, dependencyMap) {
  "use strict";
  const base = require(dependencyMap[0]);
  module.exports = base * 2;
}, 11, [12], "legacy/double.js");
__d(function (global, require, importDefault, importAll, module, exports) {
  "use strict";
  Object.defineProperty(exports, "__esModule", { value: true });
  exports.default = 20;
}, 12, [], "legacy/base.js");
__r(10);
