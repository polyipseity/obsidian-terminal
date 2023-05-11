interface ObjectConstructor {
	// eslint-disable-next-line @typescript-eslint/ban-types, @typescript-eslint/method-signature-style
	freeze<const T extends Function>(f: T): T
	// eslint-disable-next-line @typescript-eslint/method-signature-style
	freeze<const T extends Record<string, U | object | null | undefined>,
		U extends bigint | boolean | number | string | symbol>(o: T): Readonly<T>
	// eslint-disable-next-line @typescript-eslint/method-signature-style
	freeze<const T>(o: T): Readonly<T>
}
