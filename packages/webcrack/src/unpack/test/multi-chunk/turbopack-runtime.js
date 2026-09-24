(globalThis.TURBOPACK = globalThis.TURBOPACK || []).push(["runtime.js", {
"[project]/src/greet.js [app-client] (ecmascript)": (({ r: __turbopack_require__, i: __turbopack_import__, m: module, e: exports }) => (() => {
"use strict";
const nameModule = __turbopack_require__("[project]/src/name.js [app-client] (ecmascript)");
async function loadExtra() {
    const extra = await __turbopack_import__("[project]/src/extra.js [app-client] (ecmascript)");
    return extra.value;
}
function greet() {
    return "hello " + nameModule.name;
}
module.exports = {
    greet,
    loadExtra
};
})()),
"[project]/src/name.js [app-client] (ecmascript)": (({ r: __turbopack_require__, m: module, e: exports }) => (() => {
"use strict";
const missing = __turbopack_require__(99999);
exports.name = "world";
})()),
}]);
