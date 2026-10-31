// Stable handles allow two-way cooperation without circular ES module imports.
export function createPorts(names) {
    if (new Set(names).size !== names.length) throw new Error('Duplicate service name');
    return Object.fromEntries(names.map(name => [name, Object.create(null)]));
}

export function installPort(target, service) {
    if (Reflect.ownKeys(target).length) throw new Error('Service already installed');
    Object.defineProperties(target, Object.getOwnPropertyDescriptors(service));
}

export function sealPorts(ports) {
    for (const [name, service] of Object.entries(ports)) {
        if (!Reflect.ownKeys(service).length) throw new Error(`Service not installed: ${name}`);
        Object.freeze(service);
    }
    return Object.freeze(ports);
}
