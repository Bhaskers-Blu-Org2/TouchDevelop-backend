/// <reference path='../typings/node/node.d.ts' />

'use strict';

import * as td from './td';
import * as assert from 'assert';

type JsonObject = td.JsonObject;
type JsonBuilder = td.JsonBuilder;

var asArray = td.asArray;

import * as parallel from "./parallel"
import * as restify from "./restify"
import * as indexedStore from "./indexed-store"
import * as core from "./tdlite-core"
import * as tdliteScripts from "./tdlite-scripts"
import * as audit from "./tdlite-audit"
import * as search from "./tdlite-search"
import * as notifications from "./tdlite-notifications"
import * as tdliteTdCompiler from "./tdlite-tdcompiler"
import * as tdliteDocs from "./tdlite-docs"
import * as tdliteData from "./tdlite-data"
import * as tdliteReleases from "./tdlite-releases"
import * as tdliteArt from "./tdlite-art"
import * as tdliteUsers from "./tdlite-users"

export type StringTransformer = (text: string) => Promise<string>;

var withDefault = core.withDefault;
var orEmpty = td.orEmpty;

var logger = core.logger;
var httpCode = core.httpCode;

var pointers: indexedStore.Store;
var deployChannels: string[];
export var templateSuffix: string = "";

export class PubPointer
    extends core.Publication
{
    @td.json public path: string = "";
    @td.json public scriptid: string = "";
    @td.json public artid: string = "";
    @td.json public htmlartid: string = "";
    @td.json public redirect: string = "";
    @td.json public description: string = "";
    @td.json public comments: number = 0;    
    @td.json public parentpath: string = "";
    @td.json public scriptname: string = "";
    @td.json public scriptdescription: string = "";
    @td.json public breadcrumbtitle: string = "";
    @td.json public customtick: string = "";
    static createFromJson(o:JsonObject) { let r = new PubPointer(); r.fromJson(o); return r; }
}

export async function reindexStoreAsync(req: core.ApiRequest, store: indexedStore.Store, processOneAsync: td.Action1<{}>) {
    if (!core.checkPermission(req, "operator")) return;
    let lst = await store.getIndex("all").fetchAsync("all", req.queryOptions);
    let resp = {
        continuation: lst.continuation,
        itemCount: lst.items.length,
        itemsReindexed: 0
    }
    await parallel.forJsonAsync(lst.items, async(e) => {
        await processOneAsync(e);
    }, 20)
    req.response = resp;
}

export async function initAsync() : Promise<void>
{
    deployChannels = withDefault(td.serverSetting("CHANNELS", false), core.myChannel).split(",");
    templateSuffix = orEmpty(td.serverSetting("TEMPLATE_SUFFIX", true));

    // TODO cache compiler queries (with expiration)
    pointers = await indexedStore.createStoreAsync(core.pubsContainer, "pointer");
    core.registerPubKind({
        store: pointers,
        deleteWithAuthor: true,
        specialDeleteAsync: clearPtrCacheAsync,
    })
    await core.setResolveAsync(pointers, async (fetchResult: indexedStore.FetchResult, apiRequest: core.ApiRequest) => {
        await core.addUsernameEtcAsync(fetchResult);
        let coll = (<PubPointer[]>[]);
        for (let jsb of fetchResult.items) {
            let ptr = PubPointer.createFromJson(jsb["pub"]);
            coll.push(ptr);
        }
        fetchResult.items = td.arrayToJson(coll);
    }, {
        byUserid: true,
        anonSearch: true
    });

    await pointers.createIndexAsync("rootns", entry => orEmpty(entry["id"]).replace(/^ptr-/, "").replace(/-.*/, ""));
    
    core.addRoute("GET", "pointers", "*", async(req) => {
        await core.anyListAsync(pointers, req, "rootns", req.verb);    
    })
    
    core.addRoute("GET", "pointers", "doctoc", async(req) => {
        let lst = await pointers.getIndex("rootns").fetchAllAsync("docs");        
        lst = lst.filter(e => !!e["pub"]["scriptid"])
        let tot = 0
        let totC = 0
        for (let e of lst) {
            e["children"] = [];
            e["orphan"] = true;
            e["pub"]["path"] = e["pub"]["path"].replace(/^\/+/, ""); 
            tot++;
        }
        let byPath = td.toDictionary(lst, e => e["pub"]["path"])        
        for (let e of lst) {
            let pub = e["pub"]
            let par = pub["parentpath"] 
            if (par != pub["path"] && par && byPath.hasOwnProperty(par)) {
                byPath[par]["children"].push(e)
                e["orphan"] = false;
                totC++
            }
        }
        let res = `tot:${tot}, ch:${totC}\n`
        let num = 0
        let dumpList = (ind: string, ee: {}[]) => {
            if (num++ > 1000) return; 
            ee.sort((a, b) => td.strcmp(a["id"], b["id"]))
            for (let e of ee) {
                res += ind + e["pub"]["scriptname"] + " /" + e["pub"]["path"] + "\n"
                dumpList(ind + "    ", e["children"])
            }
        }
        dumpList("", lst.filter(e => e["orphan"]))        
        req.response = res;
    })
    
    core.addRoute("GET", "*script", "cardinfo", async (req14: core.ApiRequest) => {
        let jsb1 = await getCardInfoAsync(req14, req14.rootPub);
        req14.response = td.clone(jsb1);
    });
    core.addRoute("POST", "pointers", "", async (req: core.ApiRequest) => {
        await core.canPostAsync(req, "pointer");
        if (req.status == 200) {
            let body = req.body;
            let ptr1 = new PubPointer();
            ptr1.path = orEmpty(body["path"]).replace(/^\/+/g, "");
            ptr1.id = pathToPtr(ptr1.path);
            if (!checkPostPointerPermissions(req))
                return;
            let matches = (/^usercontent\/([a-z]+)$/.exec(ptr1.path) || []);
            if (matches[1] == null) {
                if (td.startsWith(ptr1.path, "users/" + req.userid + "/")) {
                    core.checkPermission(req, "custom-ptr");
                }
                else {
                    core.checkPermission(req, "root-ptr");
                    if (req.status == 200 && ! hasPtrPermission(req, ptr1.id)) {
                        req.status = httpCode._402PaymentRequired;
                    }
                }
            }
            else {
                let entry2 = await core.getPubAsync(matches[1], "script");
                if (entry2 == null || entry2["pub"]["userid"] != req.userid) {
                    core.checkPermission(req, "root-ptr");
                }
            }
            if (req.status == 200 && ! /^[\w\/\-@]+$/.test(ptr1.path)) {
                req.status = httpCode._412PreconditionFailed;
            }
            if (req.status == 200) {
                let existing = await core.getPubAsync(ptr1.id, "pointer");
                if (existing != null) {
                    req.rootPub = existing;
                    req.rootId = existing["id"];
                    await updatePointerAsync(req);
                }
                else {
                    ptr1.userid = req.userid;
                    ptr1.userplatform = core.getUserPlatforms(req);
                    let jsb1 = {};
                    jsb1["id"] = ptr1.id;
                    jsb1["pub"] = ptr1.toJson();
                    await setPointerPropsAsync(req, jsb1, body);
                    await pointers.insertAsync(jsb1);
                    await notifications.storeAsync(req, jsb1, "");
                    await search.scanAndSearchAsync(jsb1);
                    await clearPtrCacheAsync(ptr1.id);
                    await audit.logAsync(req, "post-ptr", {
                        newvalue: td.clone(jsb1)
                    });
                    await core.returnOnePubAsync(pointers, td.clone(jsb1), req);
                }
            }
        }
    });
    core.addRoute("POST", "*pointer", "", async (req1: core.ApiRequest) => {
        await updatePointerAsync(req1);
    });
    core.addRoute("GET", "*pointer", "history", async(req) => {
        if (!core.checkPermission(req, "root-ptr")) return;
        let fetchResult = await audit.queryPubLogAsync(req);
        fetchResult.items = fetchResult.items.filter(e => e["pub"]["type"] == "update-ptr");
        
        let last = fetchResult.items[fetchResult.items.length - 1]
        if (last && last["pub"]["oldvalue"] && last["pub"]["oldvalue"]["__version"] == 1) {
            let final = td.clone(last);
            let pub = last["pub"]["oldvalue"];
            final["pub"]["newvalue"] = pub;
            final["pub"]["oldvalue"] = null;
            final["pub"]["userid"] = pub["pub"]["userid"];
            final["pub"]["time"] = pub["pub"]["time"];
            fetchResult.items.push(final)
        }
        
        fetchResult.items = fetchResult.items.map(it => {
            let pub = it["pub"];
            let ptr = it["pub"]["newvalue"];
            let ptrpub = ptr["pub"];
            ptrpub["userid"] = pub["userid"];
            ptrpub["time"] = pub["time"];
            ptr["id"] = ptr["id"] + "@v" + ptr["__version"]
            if (pub["oldvalue"])
                ptr["oldscriptid"] = pub["oldvalue"]["pub"]["scriptid"];
            return ptr;
        });
        
        await core.addUsernameEtcAsync(fetchResult);        
        fetchResult.items = fetchResult.items.map(jsb => {
            let ptr = PubPointer.createFromJson(jsb["pub"]);
            let ret = ptr.toJson();
            ret["oldscriptid"] = jsb["oldscriptid"];
            return ret; 
        })

        req.response = fetchResult.toJson();        
    });
    tdliteDocs.init(async (v: JsonBuilder) => {
        let wp = orEmpty(v["webpath"]);
        if (wp != "") {
            let ptrId = pathToPtr(wp.replace(/^\//g, ""));
            v["ptrid"] = ptrId;
            let entry = await core.getPubAsync(ptrId, "pointer");
            if (entry != null) {
                let s = entry["pub"]["scriptid"];
                if (orEmpty(s) != "") {
                    v["id"] = s;
                }
            }
        }
        let pubObj = await core.getPubAsync(v["id"], "script");
        if (pubObj != null) {
            v["isvolatile"] = true;
            let jsb2 = await getCardInfoAsync(core.emptyRequest, pubObj);
            // use values from expansion only if there are not present in v
            td.jsonCopyFrom(jsb2, td.clone(v));
            td.jsonCopyFrom(v, td.clone(jsb2));
        }
        let promotag = orEmpty(v["promotag"]);
        if (promotag != "") {
            let apiReq = core.buildApiRequest("/api/promo-scripts/all?count=50");
            let entities = await core.fetchAndResolveAsync(tdliteScripts.scripts, apiReq, "promo", promotag);
            v["promo"] = entities.items;
        }
    });
    core.addRoute("POST", "admin", "reindexpointers", async (req2: core.ApiRequest) => {
        core.checkPermission(req2, "operator");
        if (req2.status == 200) {
            /* async */ pointers.getIndex("all").forAllBatchedAsync("all", 50, async (json) => {
                await parallel.forJsonAsync(json, async (json1: JsonObject) => {
                });
            });
            req2.response = ({});
        }
    });
    
    core.addRoute("POST", "pointers", "reindex", async(req: core.ApiRequest) => {
        await reindexStoreAsync(req, pointers, async(ptr) => {
            let refx = await pointers.reindexAsync(ptr["id"], async(entry1: JsonBuilder) => {
                await setPointerPropsAsync(core.adminRequest, entry1, {});
            }, true);
            await audit.logAsync(req, "reindex-ptr", {
                oldvalue: ptr,
                newvalue: refx
            });
        });
    });
    
    restify.server().get("/:userid/oauth", async(req, res) => {
        let lang = await handleLanguageAsync(req);
        let uid = req.param("userid")
        let user = await tdliteUsers.getAsync(uid)
        
        if (!user) {
            let tmp = await errorHtmlAsync("User account not found", "No such user: /" + uid, lang)
            res.html(tmp, { status: httpCode._404NotFound })
        } else {
            let text = await simplePointerCacheAsync("templates/oauth", lang)
            text = await tdliteDocs.formatAsync(text, {
                id: uid,
                name: user.pub.name
            })
            res.html(text)
        }        
    })    
}

export function pathToPtr(fn: string) : string
{
    let s: string;
    if (! fn) {
        return "";
    }
    s = "ptr-" + fn.replace(/^\/+/g, "").replace(/[^a-zA-Z0-9@]/g, "-").toLowerCase();
    return s;
}

async function setPointerPropsAsync(req:core.ApiRequest, ptr: JsonBuilder, body: JsonObject) : Promise<void>
{
    let pub = ptr["pub"];
    let empty = new PubPointer().toJson();
    for (let k of Object.keys(empty)) {
        if ( ! pub.hasOwnProperty(k)) {
            pub[k] = empty[k];
        }
    }
    core.setFields(pub, body, ["description", "scriptid", "redirect", "artid", "artcontainer", "htmlartid", "customtick", "path"]);
    pub["path"] = pub["path"].replace(/^\/+/, "");
    pub["parentpath"] = "";
    pub["scriptname"] = "";
    pub["scriptdescription"] = "";
    let sid = await core.getPubAsync(pub["scriptid"], "script");
    if (sid == null) {
        pub["scriptid"] = "";
    }
    else {
        pub["scriptname"] = sid["pub"]["name"];
        pub["scriptdescription"] = sid["pub"]["description"];
        await core.pubsContainer.updateAsync(sid["id"], async (entry: JsonBuilder) => {
            entry["lastPointer"] = pub["id"];
        });
        let entry1 = await tdliteScripts.getScriptTextAsync(sid["id"]);
        let parentTopic = (<JsonObject>null);
        if (entry1 != null) {
            let coll = (/{parent[tT]opic:([\w\/@\-]+)}/.exec(orEmpty(entry1["text"])) || []);
            let r = orEmpty(coll[1]);
            if (r != "") {
                parentTopic = await core.getPubAsync(pathToPtr(r), "pointer");
            }
            coll = (/{bread[Cc]rumb[tT]itle:([^{}]+)}/.exec(orEmpty(entry1["text"])) || []);
            pub["breadcrumbtitle"] = withDefault(coll[1], pub["scriptname"]);
        }
        if (parentTopic == null) {
            let currid = pub["path"];
            for (let i = 0; i < 5; i++) {
                currid = currid.replace(/[^\/]*$/g, "").replace(/\/$/g, "");
                if (currid == "") {
                    break;
                }
                parentTopic = await core.getPubAsync(pathToPtr(currid), "pointer");
                if (parentTopic != null) {
                    break;
                }
            }
        }
        if (parentTopic != null) {
            let parentRedir = orEmpty(parentTopic["pub"]["redirect"]);
            if (parentRedir != "") {
                parentTopic = await core.getPubAsync(pathToPtr(parentRedir), "pointer");
            }
        }
        if (parentTopic != null) {
            pub["parentpath"] = parentTopic["pub"]["path"];
        }
    }
    sid = await core.getPubAsync(pub["artid"], "art");
    if (sid == null) {
        pub["artid"] = "";
    }
    let s = orEmpty(pub["redirect"]);
    if (!core.callerHasPermission(req, "post-raw") && ! /^\/[a-zA-Z0-9\/\-@]+$/.test(s)) {
        pub["redirect"] = "";
    }
}

async function checkPostPointerPermissions(req: core.ApiRequest) {
    if (req.body["htmlartid"])
        core.checkPermission(req, "post-raw");
    if (req.body["customtick"])
        core.checkPermission(req, "operator");
    return req.status == 200;
}

async function updatePointerAsync(req: core.ApiRequest): Promise<void> {
    if (req.userid == req.rootPub["pub"]["userid"]) {
    }
    else {
        core.checkPermission(req, "root-ptr");
        if (req.status == 200 && !hasPtrPermission(req, req.rootId)) {
            req.status = httpCode._402PaymentRequired;
        }
    }
    
    if (!checkPostPointerPermissions(req))
        return;
    
    if (req.status == 200) {
        let bld = await search.updateAndUpsertAsync(core.pubsContainer, req, async(entry: JsonBuilder) => {
            await setPointerPropsAsync(req, entry, req.body);
        });
        await audit.logAsync(req, "update-ptr", {
            oldvalue: req.rootPub,
            newvalue: td.clone(bld)
        });
        await clearPtrCacheAsync(req.rootId);
        await core.returnOnePubAsync(pointers, td.clone(bld), req);
    }
}

async function getHtmlArtAsync(templid: string) {
    let artjs = await core.getPubAsync(templid, "art");
    if (artjs == null) {
        return "Template art missing";
    }
    else if (orEmpty(artjs["contentType"]) == "text/plain") {
        let url = tdliteArt.getBlobUrl(artjs)
        let resp = await td.createRequest(url).sendAsync();
        let textObj = resp.content();
        if (!textObj) {
            return "Art text not found.";
        }
        else {
            return textObj;
        }
    }

}

export async function getTemplateTextAsync(templatename: string, lang: string) : Promise<string>
{
    let r: string;
    let id = pathToPtr(templatename.replace(/:.*/g, ""));
    let entry3 = await core.getPubAsync(id + lang, "pointer"); 
    if (entry3 == null && lang != "") {
        entry3 = await core.getPubAsync(id, "pointer");
    }
    if (entry3 == null) {
        return "Template pointer leads to nowhere";
    }
    else if (entry3["pub"]["htmlartid"]) {
        return await getHtmlArtAsync(entry3["pub"]["htmlartid"]);
    }
    else {
        let templid = entry3["pub"]["scriptid"];
        let scriptjs = await core.getPubAsync(templid, "script");
        if (scriptjs == null) {
            return "Template script missing";
        }
        else if (orEmpty(scriptjs["pub"]["raw"]) == "html") {
            let textObj = await tdliteScripts.getScriptTextAsync(scriptjs["id"]);
            if (textObj == null) {
                return "Script text not found.";
            }
            else {
                return textObj["text"];
            }
        }
        else {
            return "Template has to be raw html";
            if (false) {
                let resp3 = await tdliteTdCompiler.queryCloudCompilerAsync("q/" + scriptjs["id"] + "/string-art");
                if (resp3 == null) {
                    return "Extracting strings from template failed";
                }
                else {
                    let arts1 = asArray(resp3);
                    let artid = templatename.replace(/^[^:]*:?/g, "");
                    if (artid != "") {
                        arts1 = arts1.filter(elt => elt["name"] == artid);
                    }
                    if (arts1.length == 0) {
                        return "No art matching template name (if any)";
                    }
                    else {
                        return arts1[0]["value"];
                    }
                }
            }
        }
    }
    return r;
}

async function clearPtrCacheAsync(id: string) : Promise<void>
{
    if (false) {
        await tdliteReleases.cacheRewritten.updateAsync("ptrcache/" + id, async (entry: JsonBuilder) => {
            entry["version"] = "outdated";
        });
    }
    for (let chname of deployChannels) {
        await tdliteReleases.cacheRewritten.updateAsync("ptrcache/" + chname + "/" + id, async (entry1: JsonBuilder) => {
            entry1["version"] = "outdated";
        });
        if ( ! /@\w+$/.test(id)) {
            for (let lang of Object.keys(core.serviceSettings.langs)) {
                await tdliteReleases.cacheRewritten.updateAsync("ptrcache/" + chname + "/" + id + "@" + lang, async (entry2: JsonBuilder) => {
                    entry2["version"] = "outdated";
                });
            }
        }
    }
    if (td.startsWith(id, "ptr-templates-")) {
        await tdliteReleases.pokeReleaseAsync("cloud", 0);
    }
}

function fixupTDHtml(html: string): string
{
    html = html
        .replace(/^<h1>[^<>]+<\/h1>/g, "")
        .replace(/<h2>/g, "<h2 class=\"beta\">")
        .replace(/(<a class="[^"<>]*" href=")\//g, (f, p) => p + core.self)
        .replace(/<h3>/g, "<h3 class=\"gamma\">");
    return html; 
}

async function renderScriptAsync(scriptid: string, v: CachedPage, pubdata: JsonBuilder): Promise<void> {
    pubdata["done"] = false;
    pubdata["templatename"] = "";
    pubdata["msg"] = "";

    let scriptjs = await core.getPubAsync(scriptid, "script");
    if (!scriptjs) {
        pubdata["msg"] = "Pointed script not found";
        return
    }

    let editor = orEmpty(scriptjs["pub"]["editor"]);
    let raw = orEmpty(scriptjs["pub"]["raw"]);

    if (raw == "html") {
        let entry = await tdliteScripts.getScriptTextAsync(scriptjs["id"]);
        v.text = entry["text"];
        pubdata["done"] = true;
        return;
    }

    if (editor != "") {
        pubdata["msg"] = "Unsupported doc script editor";
        return;
    }

    td.jsonCopyFrom(pubdata, scriptjs["pub"]);
    pubdata["scriptId"] = scriptjs["id"];
    let userid = scriptjs["pub"]["userid"];
    let userjs = await tdliteUsers.getAsync(userid);
    let username = "User " + userid;
    let allowlinks = "";
    if (core.hasPermission(userjs, "external-links")) {
        allowlinks = "-official";
    }
    let resp2 = await tdliteTdCompiler.queryCloudCompilerAsync("q/" + scriptjs["id"] + "/raw-docs" + allowlinks);
    if (!resp2) {
        pubdata["msg"] = "Rendering failed";
        return;
    }

    let official = core.hasPermission(userjs, "root-ptr");
    if (userjs != null) {
        username = withDefault(userjs["pub"]["name"], username);
    }
    pubdata["username"] = username;
    pubdata["userid"] = userid;
    pubdata["body"] = fixupTDHtml(resp2["body"]);
    let desc = pubdata["description"];
    pubdata["hashdescription"] = desc;
    pubdata["description"] = desc.replace(/#\w+/g, "");
    pubdata["doctype"] = "Documentation";
    pubdata["time"] = scriptjs["pub"]["time"];
    let doctype = withDefault((/ptr-([a-z]+)-/.exec(pubdata["ptrid"]) || [])[1], "");
    if (!official && ! /^(users|usercontent|preview|)$/.test(doctype)) {
        official = true;
    }
    let pathConfig = core.serviceSettings.paths[doctype];
    if (pathConfig != null) {
        td.jsonCopyFrom(pubdata, pathConfig);
    }
    if (official) {
        let s = orEmpty((/#(page\w*)/.exec(desc) || [])[1]).toLowerCase();
        if (s == "") {
            pubdata["templatename"] = "templates/official-s";
        }
        else {
            pubdata["templatename"] = "templates/" + s + "-s";
        }
    }
    else {
        pubdata["templatename"] = "templates/users-s";
    }
}


async function rewriteAndCachePointerAsync(id: string, res: restify.Response, rewrite:td.Action1<CachedPage>) : Promise<void>
{
    let path = "ptrcache/" + core.myChannel + "/" + id;
    let cachedPage = <CachedPage> await tdliteReleases.cacheRewritten.getAsync(path);
    let ver = await core.getCloudRelidAsync(true);

    let event = "ServePtr";
    let cat = "other";
    if (id == "ptr-home") {
        cat = "home";
    }
    else if (td.startsWith(id, "ptr-preview-")) {
        cat = "preview";
    }
    if (cachedPage == null || cachedPage.version != ver ||
        (core.orZero(cachedPage.expiration) > 0 && cachedPage.expiration < await core.nowSecondsAsync())) {
        let lock = await core.acquireCacheLockAsync(path);
        if (lock == "") {
            await rewriteAndCachePointerAsync(id, res, rewrite);
            return;
        }

        await tdliteTdCompiler.cacheCloudCompilerDataAsync(ver);

        cachedPage = {
            contentType: "text/html",
            version: ver,
            expiration: await core.nowSecondsAsync() + td.randomRange(2000, 3600),
            status: 200,
            error: false,
        };
        await rewrite(cachedPage);

        if (cachedPage.version == ver) {
            await tdliteReleases.cacheRewritten.updateAsync(path, async (entry: JsonBuilder) => {
                core.copyJson(cachedPage, entry);
            });
        }
        await core.releaseCacheLockAsync(lock);
        event = "ServePtrFirst";
    }

    if (res.finished()) {
        return;
    }
    let redir = orEmpty(cachedPage.redirect);
    if (redir == "") {
        let status0 = core.orZero(cachedPage.status);
        if (status0 == 0) {
            status0 = 200;
        }
        res.sendText(cachedPage.text, cachedPage.contentType, {
            status: status0
        });
        if (core.orFalse(cachedPage.error)) {
            cat = "error";
        }
        logger.debug("serve ptr2: " + event + " " + cat + " " + path);
        logger.measure(event + "@" + cat, logger.contextDuration());
    }
    else {
        res.redirect(302, redir);
    }
    
    if (cachedPage.customtick)
        logger.tick(cachedPage.customtick)
}

async function lookupScreenshotIdAsync(pub: {}) {
    let pref = core.currClientConfig.primaryCdnUrl + "/thumb1/"
    let text = await tdliteScripts.getScriptTextAsync(pub["id"]);
    if (text && text["text"]) {
        let m = /^var screenshot : Picture[^]*?url =.*?msecnd\.net\/pub\/([a-z]+)/m.exec(text["text"])
        if (m) return pref + m[1]
    }
    let id = pub["iconArtId"]
    if (id) return pref + id;
    
    let ss = await tdliteArt.getPubScreenshotsAsync(pub["id"], 1)
    if (ss[0]) {
        return pref.replace("thumb1", "pub") + ss[0]["id"]
    }
    
    return "";
}

async function renderScriptPageAsync(scriptjson: {}, v: CachedPage, lang:string)
{    
    let req = core.buildApiRequest("/api")
    req.rootId = scriptjson["id"];    // this is to make sure we show hidden scripts
    let pub = await core.resolveOnePubAsync(tdliteScripts.scripts, scriptjson, req);
    let templ = "templates/script"
    if (/#stepByStep/i.test(pub["description"]))
        templ = "templates/tutorial";
    else if (/#docs/i.test(pub["description"]))
        templ = "templates/docscript";
    pub["templatename"] = templ;
    pub["screenshoturl"] = await lookupScreenshotIdAsync(pub); 
    await renderFinalAsync(pub, v, lang);
}

interface CachedPage {
    contentType: string;
    version: string;
    redirect?: string;
    text?: string;
    error: boolean;
    customtick?: string;
    status: number;
    expiration: number;
}

function legacyKindPrefix(name: string)
{
    name = name.replace(/^docs\//, "").toLowerCase();
    
    if (tdliteData.tdLegacyKinds.hasOwnProperty(name))
        return null;

    let len = Math.min(25, name.length)
    while (len > 0) {        
        let sl = name.slice(0, len);
        if (tdliteData.tdLegacyKinds.hasOwnProperty(sl))
            return sl;
        len--;
    }
    return null;
}

export async function servePointerAsync(req: restify.Request, res: restify.Response) : Promise<void>
{
    let lang = await handleLanguageAsync(req);
    let fn = req.url().replace(/\?.*/g, "").replace(/^\//g, "").replace(/\/$/g, "").toLowerCase();
    if (fn == "") {
        fn = "home";
    }
    let id = pathToPtr(fn);
    let pathLang = orEmpty((/@([a-z][a-z])$/.exec(id) || [])[1]);
    if (pathLang != "") {
        if (pathLang == core.serviceSettings.defaultLang) {
            id = id.replace(/@..$/g, "");
            lang = "";
        }
        else {
            lang = "@" + pathLang;
        }
    }
    if (templateSuffix != "" && core.serviceSettings.envrewrite.hasOwnProperty(id.replace(/^ptr-/g, ""))) {
        id = id + templateSuffix;
    }
    id = id + lang;
    
    if (!core.fullTD && req.query()["update"] == "true" && /^[a-z]+$/.test(fn)) {
        let entry = await core.getPubAsync(fn, "script")
        if (entry) {
            entry = await tdliteScripts.updateScriptAsync(entry)
            res.redirect(httpCode._302MovedTemporarily, "/app/#pub:" + entry["id"])
            return
        }
    }

    await rewriteAndCachePointerAsync(id, res, async (v: CachedPage) => {
        let pubdata = {};
        let errorAsync = async(msg: string) => {
            await pointerErrorAsync(msg, v, lang)
        } 
        v.redirect = "";
        v.text = "";
        v.error = false;
        v.customtick = null;
        pubdata["webpath"] = fn;
        pubdata["ptrid"] = id;
        let existing = await core.getPubAsync(id, "pointer");
        if (existing == null && /@[a-z][a-z]$/.test(id)) {
            existing = await core.getPubAsync(id.replace(/@..$/g, ""), "pointer");
        }
        if (existing)
            v.customtick = existing["pub"]["customtick"]
        
        if (existing == null) {          
            if (td.startsWith(fn, "u/")) {
                v.redirect = fn.replace(/^u\//g, "/usercontent/");
            }
            else if (core.fullTD && fn.startsWith("blog/")) {
                v.redirect = fn.replace(/^blog/, "/docs")
            }
            else if (core.fullTD && fn.startsWith("docs/") && legacyKindPrefix(fn)) {
                let pref = legacyKindPrefix(fn);
                v.redirect = "/docs/" + pref + "#" + fn.slice(5 + pref.length)
            }    
            else if (td.startsWith(fn, "preview/")) {
                await renderScriptAsync(fn.replace(/^preview\//g, ""), v, pubdata);
                await renderFinalAsync(pubdata, v, lang);
            }
            else if (/^[a-z]+$/.test(fn)) {
                let entry = await core.pubsContainer.getAsync(fn);
                if (entry == null || withDefault(entry["kind"], "reserved") == "reserved") {
                    await errorAsync("No such publication");
                }
                else {                    
                    if (core.fullTD && entry["kind"] == "script") {
                        await renderScriptPageAsync(entry, v, lang)
                    } else {
                        v.redirect = "/app/#pub:" + entry["id"];
                    }    
                }
            }
            else {
                await errorAsync("No such pointer");
            }
        }
        else {
            let ptr = PubPointer.createFromJson(existing["pub"]);
            if (ptr.redirect) {
                v.redirect = ptr.redirect;
            } else if (ptr.artid) {
                let artobj = await core.getPubAsync(ptr.artid, "art")
                if (!artobj) {
                    await errorAsync("No such art: /" + ptr.artid)
                } else {
                    v.redirect = core.currClientConfig.primaryCdnUrl + "/pub/" + (artobj["filename"] || artobj["id"]);
                }
            } else if (ptr.htmlartid) {
                v.text = await getHtmlArtAsync(ptr.htmlartid);
                if (/-txt$/.test(ptr.id)) {
                    v.contentType = "text/plain; charset=utf-8"
                }
            } else {
                let scriptid = ptr.scriptid;
                await renderScriptAsync(ptr.scriptid, v, pubdata);
                
                let path = ptr.parentpath;
                let breadcrumb = ptr.breadcrumbtitle;
                let sep = "&nbsp;&nbsp;»&nbsp; ";
                for (let i = 0; i < 5; i++) {
                    let parJson = await core.getPubAsync(pathToPtr(path), "pointer");
                    if (parJson == null) {
                        break;
                    }
                    let parptr = PubPointer.createFromJson(parJson["pub"]);
                    breadcrumb = "<a href=\"" + core.htmlQuote("/" + parptr.path) + "\">" + parptr.breadcrumbtitle + "</a>" + sep + breadcrumb;
                    path = parptr.parentpath;
                }
                breadcrumb = "<a href=\"/home\">Home</a>" + sep + breadcrumb;
                pubdata["breadcrumb"] = breadcrumb;
                
                await renderFinalAsync(pubdata, v, lang);
            }
        }
    });
}

async function renderFinalAsync(pubdata: {}, v: CachedPage, lang: string) {
    if (pubdata["msg"]) {
        await pointerErrorAsync(pubdata["msg"], v, lang);
        return;
    }
    if (pubdata["done"]) {
        return;
    }

    pubdata["css"] = tdliteTdCompiler.doctopicsCss;
    pubdata["rootUrl"] = core.currClientConfig.rootUrl;
    if (core.fullTD)
        pubdata["templatename"] = pubdata["templatename"].replace(/-s$/, "")
    if (!pubdata["body"]) pubdata["body"] = "";

    let templText = await getTemplateTextAsync(pubdata["templatename"] + templateSuffix, lang);
    if (templText.length < 100) {
        await pointerErrorAsync(templText, v, lang)
        return;
    }
    v.text = await tdliteDocs.formatAsync(templText, pubdata);
}

async function errorHtmlAsync(header: string, info: string, lang:string)
{
    let pubdata = {
        name: header,
        body: core.htmlQuote(info)
    }
    
    let text = await simplePointerCacheAsync("error-template", lang);
    if (text.length > 100) {
        return await tdliteDocs.formatAsync(text, pubdata);
    } else {
        return core.htmlQuote(header + "; " + info + "; and also for /error-template: " + text)
    }
}

async function pointerErrorAsync(msg: string, v: CachedPage, lang: string) {
    v.expiration = await core.nowSecondsAsync() + 5 * 60;
    let header = "Whoops, something went wrong.";
    v.status = 500;
    if (td.startsWith(msg, "No such ")) {
        header = "Sorry, the page you were looking for doesn’t exist";
        v.status = 404;
    }
    v.error = true;
    v.text = await errorHtmlAsync(header, "Error message: " + msg, lang);
}

function hasPtrPermission(req: core.ApiRequest, currptr: string) : boolean
{
    currptr = currptr.replace(/@..$/g, "");
    while (currptr != "") {
        if (core.callerHasPermission(req, "write-" + currptr)) {
            return true;
        }
        else {
            let newptr = currptr.replace(/-[^\-]*$/g, "");
            if (newptr == currptr) {
                return false;
            }
            else {
                currptr = newptr;
            }
        }
    }
    return false;
}


export async function getCardInfoAsync(req: core.ApiRequest, pubJson: JsonObject) : Promise<JsonBuilder>
{
    let jsb2: JsonBuilder;
    let js3 = await core.resolveOnePubAsync(tdliteScripts.scripts, pubJson, req);
    if (js3 == null) {
        return {};
    }
    let scr = tdliteScripts.PubScript.createFromJson(js3);
    let jsb = td.clone(js3);
    jsb["description"] = scr.description.replace(/#docs/g, "");
    let vimeo = scr.meta["vimeo"];
    if (vimeo != null) {
        // TODO use thumbnail cache
        let js2 = await td.downloadJsonAsync("https://vimeo.com/api/oembed.json?url=https%3A//vimeo.com/" + vimeo);
        jsb["vimeo"] = vimeo;
        jsb["fullpicture"] = js2["thumbnail_url"];
        jsb["thumbnail"] = js2["thumbnail_url"].replace(/_\d+\./g, "_512.");
        if (false) {
            let s2 = td.replaceAll("<iframe src=\"https://player.vimeo.com/video/{vimeo}\" width=\"500\" height=\"281\" frameborder=\"0\" webkitallowfullscreen mozallowfullscreen allowfullscreen></iframe>", "{vimeo}", vimeo);
        }
    }
    let artid = orEmpty(scr.meta["art"]);
    if (artid != "") {
        jsb["fullpicture"] = core.currClientConfig.primaryCdnUrl + "/pub/" + artid;
        jsb["thumbnail"] = core.currClientConfig.primaryCdnUrl + "/thumb1/" + artid;
    }
    if (scr.editor == "blockly") {
        td.jsonCopyFrom(jsb, ({ 
  "editorname": "Block Editor", 
  "editor": "blocks",
  "editorhtml": "Microsoft Block Editor"
}));
    }
    else {
        td.jsonCopyFrom(jsb, ({ 
  "editorname": "Touch Develop", 
  "editor": "touchdevelop",
  "editorhtml": "Microsoft Touch Develop"
}));
    }
    jsb["timems"] = scr.time * 1000;
    jsb["realid"] = scr.id;
    jsb["humantime"] = tdliteDocs.humanTime(new Date(jsb["timems"]))
    return jsb;
    return jsb2;
}


export async function handleLanguageAsync(req: restify.Request) : Promise<string>
{
    if (!req) return "";
    
    await core.refreshSettingsAsync();
    let lang = core.serviceSettings.defaultLang;
    for (let s of orEmpty(req.header("Accept-Language")).split(",")) {
        let headerLang = orEmpty((/^\s*([a-z][a-z])/.exec(s) || [])[1]);
        if (core.serviceSettings.langs.hasOwnProperty(headerLang)) {
            lang = headerLang;
            break;
        }
    }
    let cookieLang = orEmpty((/TD_LANG=([a-z][a-z])/.exec(orEmpty(req.header("Cookie"))) || [])[1]);
    if (core.serviceSettings.langs.hasOwnProperty(cookieLang)) {
        lang = cookieLang;
    }
    if (lang == core.serviceSettings.defaultLang) {
        lang = "";
    }
    else {
        lang = "@" + lang;
    }
    return lang;
}

export async function simplePointerCacheAsync(urlPath: string, lang: string) : Promise<string>
{
    let versionMarker = "simple3";
    urlPath = urlPath + templateSuffix;
    let id = pathToPtr(urlPath);
    let path = "ptrcache/" + core.myChannel + "/" + id + lang;
    let entry2 = await tdliteReleases.cacheRewritten.getAsync(path);
    if (entry2 == null || orEmpty(entry2["version"]) != versionMarker) {
        let jsb2 = {};
        jsb2["version"] = versionMarker;
        let r = await getTemplateTextAsync(urlPath, lang);
        jsb2["text"] = orEmpty(r);
        entry2 = td.clone(jsb2);
        await tdliteReleases.cacheRewritten.updateAsync(path, async (entry: JsonBuilder) => {
            core.copyJson(entry2, entry);
        });
    }
    return orEmpty(entry2["text"]);
}

