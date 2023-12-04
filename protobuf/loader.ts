"use strict";

/**
 * Adapted with modifications from https://github.com/grpc/grpc-node/tree/master/packages/proto-loader
 */

/**
 * @license
 * Copyright 2018 gRPC authors.
 *
 * Licensed under the Apache License, Version 2.0 (the "License");
 * you may not use this file except in compliance with the License.
 * You may obtain a copy of the License at
 *
 *     http://www.apache.org/licenses/LICENSE-2.0
 *
 * Unless required by applicable law or agreed to in writing, software
 * distributed under the License is distributed on an "AS IS" BASIS,
 * WITHOUT WARRANTIES OR CONDITIONS OF ANY KIND, either express or implied.
 * See the License for the specific language governing permissions and
 * limitations under the License.
 *
 */
import { Enum, Message, Method, Namespace, Reader, ReflectionObject, Root, Service, Type } from 'protobufjs';
import { FileDescriptorProto, FileDescriptorSet } from 'protobufjs/ext/descriptor';
import { addCommonProtos, loadProtosWithOptions, loadProtosWithOptionsSync } from './loader-util';
import camelCase from 'lodash.camelcase';
const Long = require("long");
export { Long };
export function isAnyExtension(obj:any) {
    return ('@type' in obj) && (typeof obj['@type'] === 'string');
}
const descriptorOptions = {
    longs: String,
    enums: String,
    bytes: String,
    defaults: true,
    oneofs: true,
    json: true,
};
function joinName(baseName:string, name:string) {
    if (baseName === '') {
        return name;
    }
    else {
        return baseName + '.' + name;
    }
}
function isHandledReflectionObject(obj:ReflectionObject) {
    return (obj instanceof Service ||
        obj instanceof Type ||
        obj instanceof Enum);
}
function isNamespaceBase(obj:ReflectionObject) {
    return obj instanceof Namespace || obj instanceof Root;
}
function getAllHandledReflectionObjects(obj:ReflectionObject, parentName:string):[string, ReflectionObject][] {
    const objName = joinName(parentName, obj.name);
    if (isHandledReflectionObject(obj)) {
        return [[objName, obj]];
    }
    else {
        if (isNamespaceBase(obj) && typeof (obj as any).nested !== 'undefined') {
            return Object.keys((obj as any).nested)
                .map(name => {
                return getAllHandledReflectionObjects((obj as any).nested[name], objName);
            })
                .reduce((accumulator, currentValue) => accumulator.concat(currentValue), []);
        }
    }
    return [];
}
function createDeserializer(cls:Type, options:any) {
    return function deserialize(argBuf:Buffer) {
        return cls.toObject(cls.decode(argBuf), options);
    };
}
function createSerializer(cls:Type) {
    return function serialize(arg:any) {
        if (Array.isArray(arg)) {
            throw new Error(`Failed to serialize message: expected object with ${cls.name} structure, got array instead`);
        }
        const message = cls.fromObject(arg);
        return cls.encode(message).finish();
    };
}
function createMethodDefinition(method:Method, serviceName:string, options:any, fileDescriptors:Buffer[]) {
    /* This is only ever called after the corresponding root.resolveAll(), so we
     * can assume that the resolved request and response types are non-null */
    const requestType = method.resolvedRequestType!;
    const responseType = method.resolvedResponseType!;
    return {
        path: '/' + serviceName + '/' + method.name,
        requestStream: !!method.requestStream,
        responseStream: !!method.responseStream,
        requestSerialize: createSerializer(requestType),
        requestDeserialize: createDeserializer(requestType, options),
        responseSerialize: createSerializer(responseType),
        responseDeserialize: createDeserializer(responseType, options),
        // TODO(murgatroid99): Find a better way to handle this
        originalName: camelCase(method.name),
        requestType: createMessageDefinition(requestType, options, fileDescriptors),
        responseType: createMessageDefinition(responseType, options, fileDescriptors),
    };
}
function createServiceDefinition(service:Service, name:string, options:any, fileDescriptors:Buffer[]) {
    const def:any = {};
    for (const method of service.methodsArray) {
        def[method.name] = createMethodDefinition(method, name, options, fileDescriptors);
    }
    return def;
}
function createMessageDefinition(message:Type, options:any, fileDescriptors:Buffer[]) {
    const messageDescriptor = message.toDescriptor('proto3');
    return {
        format: 'Protocol Buffer 3 DescriptorProto',
        serialize: createSerializer(message),
        deserialize: createDeserializer(message, options),
        type: messageDescriptor.$type.toObject(messageDescriptor, descriptorOptions),
        fileDescriptorProtos: fileDescriptors,
    };
}
function createEnumDefinition(enumType:Enum, fileDescriptors:Buffer[]) {
    const enumDescriptor = enumType.toDescriptor('proto3');
    return {
        format: 'Protocol Buffer 3 EnumDescriptorProto',
        type: enumDescriptor.$type.toObject(enumDescriptor, descriptorOptions),
        fileDescriptorProtos: fileDescriptors,
    };
}

function createDefinition(obj:ReflectionObject, name:string, options:any, fileDescriptors:Buffer[]) {
    if (obj instanceof Service) {
        return createServiceDefinition(obj, name, options, fileDescriptors);
    }
    else if (obj instanceof Type) {
        return createMessageDefinition(obj, options, fileDescriptors);
    }
    else if (obj instanceof Enum) {
        return createEnumDefinition(obj, fileDescriptors);
    }
    else {
        throw new Error('Type mismatch in reflection object handling');
    }
}

function createPackageDefinition(root:Root, options:any) {
    const def:any = {};
    root.resolveAll();
    const descriptorList = root.toDescriptor('proto3').file;
    const bufferList = descriptorList.map(value => Buffer.from(FileDescriptorProto.encode(value).finish()));
    for (const [name, obj] of getAllHandledReflectionObjects(root, '')) {
        def[name] = createDefinition(obj, name, options, bufferList);
    }
    return def;
}
function createPackageDefinitionFromDescriptorSet(decodedDescriptorSet:Message<{}>, options:any) {
    options = options || {};
    const root = (Root as any).fromDescriptor(decodedDescriptorSet);
    root.resolveAll();
    return createPackageDefinition(root, options);
}
/**
 * Load a .proto file with the specified options.
 * @param filename One or multiple file paths to load. Can be an absolute path
 *     or relative to an include path.
 * @param options.keepCase Preserve field names. The default is to change them
 *     to camel case.
 * @param options.longs The type that should be used to represent `long` values.
 *     Valid options are `Number` and `String`. Defaults to a `Long` object type
 *     from a library.
 * @param options.enums The type that should be used to represent `enum` values.
 *     The only valid option is `String`. Defaults to the numeric value.
 * @param options.bytes The type that should be used to represent `bytes`
 *     values. Valid options are `Array` and `String`. The default is to use
 *     `Buffer`.
 * @param options.defaults Set default values on output objects. Defaults to
 *     `false`.
 * @param options.arrays Set empty arrays for missing array values even if
 *     `defaults` is `false`. Defaults to `false`.
 * @param options.objects Set empty objects for missing object values even if
 *     `defaults` is `false`. Defaults to `false`.
 * @param options.oneofs Set virtual oneof properties to the present field's
 *     name
 * @param options.json Represent Infinity and NaN as strings in float fields,
 *     and automatically decode google.protobuf.Any values.
 * @param options.includeDirs Paths to search for imported `.proto` files.
 */
export function load(filename:string, options?:any) {
    return loadProtosWithOptions(filename, options).then(loadedRoot => {
        return createPackageDefinition(loadedRoot, options);
    });
}
export function loadSync(filename:string, options?:any) {
    const loadedRoot = loadProtosWithOptionsSync(filename, options);
    return createPackageDefinition(loadedRoot, options);
}
export function fromJSON(json:any, options?:any) {
    options = options || {};
    const loadedRoot = Root.fromJSON(json);
    loadedRoot.resolveAll();
    return createPackageDefinition(loadedRoot, options);
}
type DescriptorSet = { [k: string]: any }
export function loadFileDescriptorSetFromBuffer(descriptorSet:Uint8Array | Reader, options?:any) {
    const decodedDescriptorSet = FileDescriptorSet.decode(descriptorSet);
    return createPackageDefinitionFromDescriptorSet(decodedDescriptorSet, options);
}
export function loadFileDescriptorSetFromObject(descriptorSet:DescriptorSet, options?:any) {
    const decodedDescriptorSet = FileDescriptorSet.fromObject(descriptorSet);
    return createPackageDefinitionFromDescriptorSet(decodedDescriptorSet, options);
}
addCommonProtos();
//# sourceMappingURL=index.js.map