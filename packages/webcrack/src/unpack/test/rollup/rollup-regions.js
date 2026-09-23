import { sharedHelper } from './chunk-shared.a1b2c3.js';

// node_modules/is-plain-obj/index.js
function isPlainObj(value) {
	if (Object.prototype.toString.call(value) !== '[object Object]') {
		return false;
	}
	const prototype = Object.getPrototypeOf(value);
	return prototype === null || prototype === Object.prototype;
}

// src/utils.js
function formatCount(count) {
	return `${count} item${count === 1 ? '' : 's'}`;
}

// src/main.js
const data = { total: 3 };
const label = formatCount(data.total);
const valid = isPlainObj(data) && sharedHelper(data);
console.log(label, valid);

export { label, valid };
