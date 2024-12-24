import type { TypedArray } from 'is-typed-array';

declare namespace typedArrayByteLength {
	export { TypedArray };
}

declare function typedArrayByteLength(value: TypedArray): number;
declare function typedArrayByteLength(value: unknown): false;

export = typedArrayByteLength;