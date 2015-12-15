/// <reference path='../typings/node/node.d.ts' />

'use strict';

import * as td from './td';
import * as assert from 'assert';

type JsonObject = td.JsonObject;
type JsonBuilder = td.JsonBuilder;


import * as azureBlobStorage from "./azure-blob-storage"
import * as cachedStore from "./cached-store"
import * as indexedStore from "./indexed-store"
import * as restify from "./restify"
import * as core from "./tdlite-core"
import * as audit from "./tdlite-audit"
import * as tdliteTdCompiler from "./tdlite-tdcompiler"
import * as tdlitePointers from "./tdlite-pointers"
import * as tdliteUsers from "./tdlite-users"

export type StringTransformer = (text: string) => Promise<string>;

var withDefault = core.withDefault;
var orEmpty = td.orEmpty;

var logger = core.logger;
var httpCode = core.httpCode;
var releases: indexedStore.Store;
var filesContainer: azureBlobStorage.Container;
var mainReleaseName: string = "";
// TODO this is used in tdlite-pointers; it should use a different container instead
export var cacheRewritten: cachedStore.Container;
var appContainer: azureBlobStorage.Container;

export class PubRelease
    extends core.Publication
{
    @td.json public releaseid: string = "";
    @td.json public labels: IReleaseLabel[];
    @td.json public commit: string = "";
    @td.json public branch: string = "";
    @td.json public buildnumber: number = 0;
    @td.json public version: string = "";
    @td.json public name: string = "";
    static createFromJson(o:JsonObject) { let r = new PubRelease(); r.fromJson(o); return r; }
}

export interface IReleaseLabel {
    name: string;
    userid: string;
    time: number;
    releaseid: string;
    relid: string;
    numpokes: number;
}

export function appContainerUrl()
{
    return appContainer.url();
}

export async function initAsync(): Promise<void> {
    mainReleaseName = withDefault(td.serverSetting("MAIN_RELEASE_NAME", true), "current");
    cacheRewritten = await cachedStore.createContainerAsync("cacherewritten", {
        inMemoryCacheSeconds: 15,
        redisCacheSeconds: 3600
    });
    appContainer = await core.blobService.createContainerIfNotExistsAsync("app", "hidden");
    filesContainer = await core.blobService.createContainerIfNotExistsAsync("files", "hidden");

    releases = await indexedStore.createStoreAsync(core.pubsContainer, "release");
    await core.setResolveAsync(releases, async(fetchResult: indexedStore.FetchResult, apiRequest: core.ApiRequest) => {
        await core.addUsernameEtcAsync(fetchResult);
        let coll = (<PubRelease[]>[]);
        let labels = <IReleaseLabel[]>[];
        let entry3 = core.getSettings("releases");
        if (entry3 != null && entry3["ids"] != null) {
            let js = entry3["ids"];
            for (let k of Object.keys(js)) {
                labels.push(js[k]);
            }
        }
        for (let jsb of fetchResult.items) {
            let rel = PubRelease.createFromJson(jsb["pub"]);
            rel.labels = labels.filter(elt => elt.releaseid == rel.releaseid);
            let ver = orEmpty(rel.version);
            if (ver == "") {
                rel.name = rel.releaseid.replace(/.*-/g, "");
            }
            else {
                rel.name = withDefault(rel.branch, rel.releaseid.replace(/.*-\d*/g, "")) + " " + ver;
            }
            coll.push(rel);
        }
        fetchResult.items = td.arrayToJson(coll);
    }, { byUserid: true });
    
    core.addRoute("POST", "releases", "", async(req1: core.ApiRequest) => {
        core.checkPermission(req1, "upload");
        if (req1.status == 200) {
            let rel1 = new PubRelease();
            rel1.userid = req1.userid;
            rel1.time = await core.nowSecondsAsync();
            rel1.releaseid = td.toString(req1.body["releaseid"]);
            rel1.commit = orEmpty(req1.body["commit"]);
            rel1.branch = orEmpty(req1.body["branch"]);
            rel1.buildnumber = core.orZero(req1.body["buildnumber"]);
            if (looksLikeReleaseId(rel1.releaseid)) {
                await core.updateSettingsAsync("releaseversion", async(entry: JsonBuilder) => {
                    let x = core.orZero(entry[core.releaseVersionPrefix]) + 1;
                    entry[core.releaseVersionPrefix] = x;
                    rel1.version = core.releaseVersionPrefix + "." + x + "." + rel1.buildnumber;
                });
                let key = "rel-" + rel1.releaseid;
                let jsb1 = {};
                jsb1["pub"] = rel1.toJson();
                await core.generateIdAsync(jsb1, 5);
                let ok = await core.tryInsertPubPointerAsync(key, jsb1["id"]);
                if (ok) {
                    await releases.insertAsync(jsb1);
                    await core.returnOnePubAsync(releases, td.clone(jsb1), req1);
                }
                else {
                    let entry1 = await core.getPointedPubAsync(key, "release");
                    await core.returnOnePubAsync(releases, entry1, req1);
                }
            }
            else {
                req1.status = httpCode._412PreconditionFailed;
            }
        }
    });
    core.addRoute("POST", "*release", "files", async(req2: core.ApiRequest) => {
        core.checkPermission(req2, "upload");
        if (req2.status == 200) {
            let rel2 = PubRelease.createFromJson(req2.rootPub["pub"]);
            let body = req2.body;
            let buf = new Buffer(orEmpty(body["content"]), orEmpty(body["encoding"]));
            let request = td.createRequest(filesContainer.url() + "/overrideupload/" + td.toString(body["filename"]));
            let response = await request.sendAsync();
            if (response.statusCode() == 200) {
                buf = response.contentAsBuffer();
            }
            let result = await appContainer.createBlockBlobFromBufferAsync(rel2.releaseid + "/" + td.toString(body["filename"]), buf, {
                contentType: td.toString(body["contentType"])
            });
            result = await appContainer.createGzippedBlockBlobFromBufferAsync(rel2.releaseid + "/c/" + td.toString(body["filename"]), buf, {
                contentType: td.toString(body["contentType"]),
                cacheControl: "public, max-age=31556925",
                smartGzip: true
            });
            req2.response = ({ "status": "ok" });
        }
    }, { sizeCheckExcludes: "content" });
    
    core.addRoute("POST", "*release", "label", async(req3: core.ApiRequest) => {
        let name = orEmpty(req3.body["name"]);
        if (!isKnownReleaseName(name)) {
            req3.status = httpCode._412PreconditionFailed;
        }
        if (req3.status == 200) {
            core.checkPermission(req3, "lbl-" + name);
        }
        if (req3.status == 200) {
            let rel3 = PubRelease.createFromJson(req3.rootPub["pub"]);
            let lab: IReleaseLabel = <any>{};
            lab.name = name;
            lab.time = await core.nowSecondsAsync();
            lab.userid = req3.userid;
            lab.releaseid = rel3.releaseid;
            lab.relid = rel3.id;
            lab.numpokes = 0;
            await audit.logAsync(req3, "lbl-" + lab.name);
            await core.updateSettingsAsync("releases", async(entry2: JsonBuilder) => {
                let jsb2 = entry2["ids"];
                if (jsb2 == null) {
                    jsb2 = {};
                    entry2["ids"] = jsb2;
                }
                jsb2[lab.name] = lab;
                core.bareIncrement(entry2, "updatecount");
            });
            if (name == "cloud") {
                /* async */ pokeReleaseAsync(name, 15);
                /* async */ tdliteTdCompiler.deployCompileServiceAsync(rel3, req3);
            }
            req3.response = ({});
        }
    });
    core.addRoute("POST", "upload", "files", async(req4: core.ApiRequest) => {
        if (td.startsWith(orEmpty(req4.body["filename"]).toLowerCase(), "override")) {
            core.checkPermission(req4, "root");
        }
        else {
            core.checkPermission(req4, "web-upload");
        }
        if (req4.status == 200) {
            let body1 = req4.body;
            let buf1 = new Buffer(orEmpty(body1["content"]), orEmpty(body1["encoding"]));
            let result1 = await filesContainer.createGzippedBlockBlobFromBufferAsync(td.toString(body1["filename"]), buf1, {
                contentType: body1["contentType"],
                cacheControl: "public, max-age=3600",
                smartGzip: true
            });
            req4.response = ({ "status": "ok" });
        }
    }, {  sizeCheckExcludes: "content"  });

    core.addRoute("GET", "language", "touchdevelop.tgz", async(req: core.ApiRequest) => {
        let r = core.getSettings("releases")["ids"] || {}
        let labl = <IReleaseLabel>r["cloud"]
        if (labl) {
            req.status = httpCode._302MovedTemporarily;
            req.headers = {
                "location": core.currClientConfig.primaryCdnUrl + "/app/" + labl.releaseid + "/touchdevelop.tgz"
            }
        } else {
            req.status = httpCode._404NotFound;
        }
    });
}


function looksLikeReleaseId(s: string) : boolean
{
    let b: boolean;
    b = /^\d\d\d\d\d\d\d\d\d\d[a-zA-Z\d\.\-]+$/.test(s);
    return b;
}

async function rewriteIndexAsync(rel: string, relid: string, text: string) {
    let relpub = await core.getPointedPubAsync("rel-" + relid, "release");
    let prel = PubRelease.createFromJson(relpub["pub"]);
    let ccfg = clientConfigForRelease(prel);
    ccfg.releaseLabel = rel;
    let ver = orEmpty(relpub["pub"]["version"]);
    let shortrelid = td.toString(relpub["id"]);
    if (core.basicCreds == "") {
        text = td.replaceAll(text, "data-manifest=\"\"", "manifest=\"app.manifest?releaseid=" + encodeURIComponent(rel) + "\"");
    }
    let suff = "?releaseid=" + encodeURIComponent(relid) + "\"";
    text = td.replaceAll(text, "\"browsers.html\"", "\"/app/browsers.html" + suff);
    text = td.replaceAll(text, "\"error.html\"", "\"/app/error.html" + suff);
    text = td.replaceAll(text, "\"./", "\"" + core.currClientConfig.primaryCdnUrl + "/app/" + relid + "/c/");
    let verPref = "var tdVersion = \"" + ver + "\";\n" + "var tdConfig = " + JSON.stringify(ccfg.toJson(), null, 2) + ";\n";
    text = td.replaceAll(text, "var rootUrl = ", verPref + "var tdlite = \"url\";\nvar rootUrl = ");
    if (rel != "current") {
        text = td.replaceAll(text, "betaFriendlyId = \"\"", "betaFriendlyId = \"beta " + withDefault(ver, relid.replace(/.*-/g, "")) + "\"");
    }
    return text;
}

export async function serveWebAppAsync(req: restify.Request, res: restify.Response): Promise<void> {
    let rel = "cloud";
    let entry = core.getSettings("releases");
    let js = entry["ids"][rel];
    let relid = js["releaseid"];

    if (await core.throttleCoreAsync(core.sha256(req.remoteIp()) + ":webapp", 10)) {
        res.sendError(httpCode._429TooManyRequests, "Too many web app reqs");
        return;
    }

    let m = /^\/userapp\/(([^\/]*)\/)?([a-z]+)(=?)($|\?)/.exec(req.url())
    if (!m) {
        res.redirect(httpCode._302MovedTemporarily, "/invalid-webapp")
        return;
    }
    let usernameInUrl = m[2] || ""
    let wid = m[3]
    let eq = m[4]

    let scr = await core.getPubAsync(wid, "script");
    if (!scr) {
        res.redirect(httpCode._302MovedTemporarily, "/no-such-webapp")
        return;
    }
    
    let userjson = await tdliteUsers.getAsync(scr["pub"]["userid"]);
    if (!userjson) {
        // strange...
        res.redirect(httpCode._302MovedTemporarily, "/no-such-webapp-user")
        return;
    }
    
    let uname = userjson.pub.name.replace(/[^A-Za-z0-9]/g, "") || "someone"
    
    if (usernameInUrl != uname) {
        res.redirect(httpCode._302MovedTemporarily, "/userapp/" + uname + "/" + wid + eq)
        return;        
    }
    
    if (!eq) {
        let ujson = await core.pubsContainer.getAsync(scr["updateKey"])
        let uid = ujson["scriptId"]
        if (uid != scr["id"]) {
            let uscr = await core.getPubAsync(uid, "script");
            if (uscr && uscr["pub"]["time"] > scr["pub"]["time"])
                scr = uscr;
        }
    }
    
    wid = scr["id"];

    await rewriteAndCacheAsync(rel + "-" + wid, relid, "webapp.html", "text/html", res, async(text) => {
        text = await rewriteIndexAsync(rel, relid, text);
        text = text.replace("precompiled.js?a=", "/api/" + wid + "/webapp.js")
        return text;
    });
}

export async function serveReleaseAsync(req: restify.Request, res: restify.Response) : Promise<void>
{
    let coll = (/^([^\?]+)(\?.*)$/.exec(req.url()) || []);
    let fn = req.url();
    let query = "";
    if (coll[1] != null) {
        fn = coll[1];
        query = coll[2];
    }
    fn = fn.replace(/^\/app\//g, "");
    if (fn.endsWith("/")) {
        res.redirect(301, "/app/" + fn.replace(/\/+$/g, "") + query);
        return;
    }
    let rel = mainReleaseName;
    if (isKnownReleaseName(fn)) {
        rel = fn;
        fn = "";
    }
    rel = withDefault(req.query()["releaseid"], withDefault(req.query()["r"], rel));

    let relid = "";
    if (looksLikeReleaseId(rel)) {
        relid = rel;
    }
    else {
        let entry = core.getSettings("releases");
        let js = entry["ids"][rel];
        if (js == null) {
            let entry3 = await core.getPubAsync(rel, "release");
            if (entry3 == null) {
                res.sendError(404, "no such release: " + rel);
            }
            else {
                relid = entry3["pub"]["releaseid"];
            }
        }
        else {
            relid = js["releaseid"];
        }
    }
    if (relid != "") {
        if (fn == "" && relid == "2519967637668242448-920d9e58.a88e.4fa8.bcd1.9be5ba29da9f-workerjs") {
            let s = await tdlitePointers.simplePointerCacheAsync("/worker.js", "") || "";
            res.sendText(s, "application/javascript");            
        }
        else if (fn == "") {
            await rewriteAndCacheAsync(rel, relid, "index.html", "text/html", res, async(text: string) => {
                return await rewriteIndexAsync(rel, relid, text)
            });
        }
        else if (/\.manifest$/.test(fn)) {
            await rewriteAndCacheAsync(rel, relid, "app.manifest", "text/cache-manifest", res, async (text: string) => {
                let result1: string;
                text = td.replaceAll(text, "../../../", core.currClientConfig.primaryCdnUrl + "/");
                text = td.replaceAll(text, "./", core.currClientConfig.primaryCdnUrl + "/app/" + relid + "/c/");
                text = text + "\n# v" + core.rewriteVersion + "\n";
                result1 = text;
                return result1;
            });
        }
        else if (/\.browsers$/.test(fn)) {
            res.redirect(httpCode._301MovedPermanently, "/app/browsers.html");
        }
        else if (/\.error$/.test(fn)) {
            res.redirect(httpCode._301MovedPermanently, "/app/error.html");
        }
        else if (fn == "error.html" || fn == "browsers.html") {
            await rewriteAndCacheAsync(rel, relid, fn, "text/html", res, async (text2: string) => {                
                return td.replaceAll(text2, "\"./", "\"" + core.currClientConfig.primaryCdnUrl + "/app/" + relid + "/c/");
            });
        }
        else {
            res.sendError(404, "get file from CDN");
        }
    }
}

function isKnownReleaseName(fn: string) : boolean
{
    let b: boolean;
    b = /^(beta|current|latest|cloud)$/.test(fn);
    return b;
}

async function rewriteAndCacheAsync(rel: string, relid: string, srcFile: string, contentType: string, res: restify.Response, rewrite: StringTransformer) : Promise<void>
{
    let path = relid + "/" + rel + "/" + core.myChannel + "/" + srcFile;
    let entry2 = await cacheRewritten.getAsync(path);
    if (entry2 == null || entry2["version"] != core.rewriteVersion) {
        let lock = await core.acquireCacheLockAsync(path);
        if (lock == "") {
            await rewriteAndCacheAsync(rel, relid, srcFile, contentType, res, rewrite);
            return;
        }

        let info = await appContainer.getBlobToTextAsync(relid + "/" + srcFile);
        if (info.succeded()) {
            let text = await rewrite(info.text());
            await cacheRewritten.updateAsync(path, async (entry: JsonBuilder) => {
                entry["version"] = core.rewriteVersion;
                entry["text"] = text;
            });
            res.sendText(text, contentType);
        }
        else {
            res.sendError(404, "missing file");
        }
        await core.releaseCacheLockAsync(lock);
    }
    else {
        res.sendText(entry2["text"], contentType);
    }
    logger.measure("ServeApp@" + srcFile, logger.contextDuration());
}

export async function pokeReleaseAsync(relLabel: string, delay: number) : Promise<void>
{
    await td.sleepAsync(delay);
    await core.updateSettingsAsync("releases", async (entry: JsonBuilder) => {
        let jsb = entry["ids"][relLabel];
        jsb["numpokes"] = jsb["numpokes"] + 1;
    });
}

export function clientConfigForRelease(prel: PubRelease) : core.ClientConfig
{
    let ccfg: core.ClientConfig;
    ccfg = core.ClientConfig.createFromJson(core.currClientConfig.toJson());
    ccfg.tdVersion = prel.version;
    ccfg.releaseid = prel.releaseid;
    ccfg.relid = prel.id;
    return ccfg;
}

var faviconIco: Buffer;
export async function getFaviconAsync() {
    if (faviconIco == null) {
        let res = await filesContainer.getBlobToBufferAsync("favicon.ico");
        faviconIco = res.buffer();
    }
    return faviconIco;
}
