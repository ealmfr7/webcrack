import { shared } from './src/shared.js';
import './chunk-vendor.a1b2c3.js';

// src/utils.js
function formatCount(count) {
	return `${count} item${count === 1 ? '' : 's'}`;
}

// src/main.js
const label = formatCount(3);
const valid = shared({ total: 3 });
console.log(label, valid);

export { label, valid };
