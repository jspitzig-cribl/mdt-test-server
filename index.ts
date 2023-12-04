import { loadPackageDefinition, GrpcObject, Server, ServerCredentials } from "@grpc/grpc-js";
import { load } from "./protobuf/loader";
import { inspect } from 'util';

type ProtoMap = {[filename:string]:Promise<any>}
const protos:ProtoMap = {}
async function _loadProtoDefinition<T extends GrpcObject>(protoFile:string, includeDirs?:string[]) :Promise<T>{
  const packageDefinition = await load(protoFile, {
    includeDirs
  });
  return loadPackageDefinition(packageDefinition) as T;
}
async function loadProtoDefinition<T extends GrpcObject>(protoFile:string, includeDirs?:string[]) :Promise<T>{
  if(protos[protoFile] == null) protos[protoFile] = _loadProtoDefinition(protoFile, includeDirs);
  return protos[protoFile] as Promise<T>;
}
const TELEMETRY_PROTO = './protos/telemetry.proto';
const DIAL_OUT_PROTO = './protos/mdt_grpc_dialout.proto';
const l = {
  telemetryProto: () => loadProtoDefinition(TELEMETRY_PROTO),
  dialOutProto: () => loadProtoDefinition(DIAL_OUT_PROTO),
}

function selfDescribingProtobufToObject(obj:any, fields:any[]) {
  for(const field of fields) {
    if(field.fields) {
      obj[field.name] = {};
      selfDescribingProtobufToObject(obj[field.name], field.fields);
    } else if(field.bytesValue) {
      obj[field.name] = field.bytesValue;
    } else if(field.stringValue) {
      obj[field.name] = field.stringValue;
    } else if(field.boolValue) {
      obj[field.name] = field.boolValue;
    } else if(field.uint32Value) {
      obj[field.name] = field.uint32Value;
    } else if(field.uint64Value) {
      obj[field.name] = field.uint64Value;
    } else if(field.sint32Value) {
      obj[field.name] = field.sint32Value;
    } else if(field.sint64Value) {
      obj[field.name] = field.sint64Value;
    } else if(field.doublValue) {
      obj[field.name] = field.doubleValue;
    } else if(field.floatValue) {
      obj[field.name] = field.floatValue;
    }
  }
}

async function parseMessage(message:any) {
  const telemetryProto:any = await l.telemetryProto();
  const data:Buffer = message.data;
  const telemetryDeserialized = telemetryProto.telemetry.Telemetry.deserialize(data);
  const gpbData = telemetryDeserialized.dataGpbkv;
  const obj = {};
  selfDescribingProtobufToObject(obj, gpbData[0].fields);
  console.log('Got message');
  console.log(inspect(obj, {showHidden: false, depth: null, colors: true}));
}

async function startServer() {
  const obj:any = await l.dialOutProto();
  const server = new Server();
  server.addService(obj.mdt_dialout.gRPCMdtDialout.service, {
    MdtDialout: (call:any) => {
      console.log('Got connection')
      call.on('data', async (message:any) => {
        try {
          await parseMessage(message);
        } catch(error) {
          console.error('Failed to parse message');
          console.error(error);
        }
      });
      call.on('end', () => {
        console.log('Connection closed');
      });
    }
  });
  await new Promise<void>((resolve, reject) => server.bindAsync('0.0.0.0:57890', ServerCredentials.createInsecure(), (err, port) => {
    if(err) reject(err);
    else{
      console.log('Server listening at 0.0.0.0:57890');
      server.start();
      resolve();
    }
  }));

}

(async () => {
  await startServer();
})().catch(e => {
  console.error('An error occurred');
  console.error(e);
});