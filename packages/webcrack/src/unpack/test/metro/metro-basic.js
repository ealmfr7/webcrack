__d(function (global, _$$_REQUIRE, _$$_IMPORT_DEFAULT, _$$_IMPORT_ALL, module, exports, _dependencyMap) {
  "use strict";
  const add = _$$_REQUIRE(_dependencyMap[0]);
  const color = _$$_REQUIRE(_dependencyMap[1]);
  module.exports = function main() {
    return add(1, 2) + " " + color;
  };
}, 0, [1, 2], "index.js");
__d(function (global, _$$_REQUIRE, _$$_IMPORT_DEFAULT, _$$_IMPORT_ALL, module, exports, _dependencyMap) {
  "use strict";
  module.exports = function add(a, b) {
    return a + b;
  };
}, 1, [], "utils/add.js");
__d(function (global, _$$_REQUIRE, _$$_IMPORT_DEFAULT, _$$_IMPORT_ALL, module, exports, _dependencyMap) {
  "use strict";
  const add = _$$_REQUIRE(_dependencyMap[0]);
  module.exports = add(40, 2);
}, 2, [1], "utils/color.js");
__r(0);
