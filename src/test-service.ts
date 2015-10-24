/// <reference path='../typings/node/node.d.ts' />

'use strict';

import * as td from './td';
import * as assert from 'assert';
import * as crypto from 'crypto';

type JsonObject = td.JsonObject;
type JsonBuilder = td.JsonBuilder;


import * as parallel from "./parallel"
import * as restify from "./restify"
import * as cachedStore from "./cached-store"
import * as libratoNode from "./librato-node"
import * as raygun from "./raygun"
import * as loggly from "./loggly"


var logger: td.AppLogger;
var testts: cachedStore.Container;

class Foo
    extends td.JsonRecord
{
    @td.json public foo1 = "";
    @td.json public foo2 = 12;
}

class Bar
    extends Foo
{
    @td.json public bar1 = "";
    @td.json public bar2 = 42;
}

export async function _initAsync() : Promise<void>
{
    logger = td.createLogger("myweb");
    
    let f = new Bar()
    console.log(f.toJson());
    f.fromJson({
        foo1: "hello",
        bar1: "world"
    })
    console.log(f.toJson());
    
    console.log(new Bar().toJson());

        await raygun.initAsync({
            saveReport: async (json: JsonObject) => {
                let jsb = td.clone(json);
                delete jsb["logMessages"];
                // td.log("SAVE: " + JSON.stringify(td.clone(jsb), null, 2));
                await td.sleepAsync(0.1);
            }

        });

    await loggly.initAsync({
        globalTags: "ticktest"
    });

    await libratoNode.initAsync({
        period: 5000
    });

    await restify.startAsync();

    await cachedStore.initAsync();

    testts = await cachedStore.createContainerAsync("testts", {
        inMemoryCacheSeconds: 5
    })

    await initRestifyAsync();

    logger.info("started...");
}

async function initRestifyAsync() : Promise<void>
{
    let server = restify.server();
    server.use(restify.authorizationParser());
    server.pre(restify.sanitizePath());
    server.use(restify.CORS());
    server.use(restify.bodyParser());
    server.use(restify.gzipResponse());
    server.use(restify.queryParser());
    server.use(restify.conditionalRequest());
    await initRoutesAsync();
}

async function initRoutesAsync() : Promise<void>
{
    let server = restify.server();

    server.get("/", async (req: restify.Request, res: restify.Response) => {
        res.send(td.serverSetting("PORT", false));
    });
    server.get("/id", async (req1: restify.Request, res1: restify.Response) => {
        res1.send(td.serverSetting("TD_WORKER_ID", false));
    });
    server.get("/store", async (req1: restify.Request, res1: restify.Response) => {
        let id = td.createRandomId(5)
        var r:any = { val: id }
        r.ok = await testts.tryInsertAsync("slot0", { val: id })
        res1.json(r)
    });
    server.get("/update", async (req1: restify.Request, res1: restify.Response) => {
        let id = td.createRandomId(5)
        await testts.updateAsync("slot0", async (js:JsonBuilder) => {
            js["val"] = id
        })
        var r:any = { val: id }
        res1.json(r)
    });
    server.get("/get", async (req1: restify.Request, res1: restify.Response) => {
        res1.json(await testts.getAsync("slot0"))
    });
    server.get("/meta", async (req2: restify.Request, res2: restify.Response) => {
        res2.json(JSON.parse(td.serverSetting("TD_DEPLOYMENT_META", false)));
    });
    server.get("/ip", async (req3: restify.Request, res3: restify.Response) => {
        res3.send(req3.remoteIp());
    });
    server.get("/print", async (req4: restify.Request, res4: restify.Response) => {
        logger.debug("before");
        res4.sendText("Hello world!", "text/plain");
        logger.debug("after");
    });
    server.get("/crash", async (req5: restify.Request, res5: restify.Response) => {
        await doStuff2Async();
        res5.send(td.serverSetting("PORT", false));
    });
    server.get("/log", async (req6: restify.Request, res6: restify.Response) => {
        setTimeout(function() {
           td.App.logException(new Error("foo"))
        }, 100)
        ;
        res6.send(td.serverSetting("PORT", false));
    });
    server.get("/loop", async (req7: restify.Request, res7: restify.Response) => {
        var num = 0;
        setInterval(function() {
          if (++num > 3) { 
             throw new Error("num " + num)
          }
        }, 1000);
        res7.send(td.serverSetting("PORT", false));
    });
    server.get("/crash2", async (req8: restify.Request, res8: restify.Response) => {
        let ref = null;
        logd("a");
        await parallel.forAsync(3, async (x: number) => {
        logd("b");
            await td.sleepAsync(0.1);
        logd("c");
            if (x == 2) {
                ref = /* async */ crashJsAsync();
            }
        });
        await ref;
        res8.send(td.serverSetting("PORT", false));
    });
    server.get("/crash3", async (req9: restify.Request, res9: restify.Response) => {
        await new Promise(resume => {
            setTimeout(function() { throw new Error("blah") }, 2000)
        });
    });
    server.get("/:user/info", async (req10: restify.Request, res10: restify.Response) => {
        let jsb = {};
        jsb["name"] = req10.param("user");
        res10.json(td.clone(jsb));
    });
}

async function doStuffAsync() : Promise<void>
{
    await td.sleepAsync(0.1);
    await someMoreInitAsync();
    for (let i = 0; i < 0; i++) {
        logger.info("some very long message some very long message some very long message some very long message some very long message some very long message some very long message some very long message some very long message some very long message some very long message some very long message some very long message some very long message some very long message some very long message some very long message some very long message some very long message some very long message some very long message some very long message some very long message some very long message some very long message some very long message some very long message some very long message some very long message some very long message some very long message some very long message some very long message some very long message some very long message some very long message some very long message some very long message some very long message some very long message some very long message some very long message some very long message some very long message some very long message some very long message some very long message some very long message some very long message some very long message some very long message some very long message some very long message some very long message some very long message some very long message some very long message some very long message some very long message some very long message some very long message some very long message some very long message ");
    }

}

function fib(p: number) : number
{
    let r: number;
    if (p < 2) {
        r = p;
    }
    else {
        r = fib(p - 1) + fib(p - 2);
    }
    return r;
}

async function someMoreInitAsync() : Promise<void>
{
    await cachedStore.initAsync();
}

async function doStuff2Async() : Promise<void>
{
    await someMoreInitAsync();
}

async function crashJsAsync() : Promise<void>
{
    await new Promise(resume => {
          setTimeout(function() { throw new Error("blah") }, 100)
    });
}

function doStuff3(j: number) : Buffer
{
    return crypto.randomBytes(j);
}

async function dieAfterAMinuteAsync() : Promise<void>
{
    await td.sleepAsync(65);
    var arr = []
    for (var i = 0; true; i++) {
      arr.push(new Buffer(128000))
    }
}


function logd(m) {
    if ((<any>process).domain) console.log(m, "domain")
    else console.log(m, "nope")
}

/* async */ _initAsync();
