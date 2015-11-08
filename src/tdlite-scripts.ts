/// <reference path='../typings/node/node.d.ts' />

'use strict';

import * as td from './td';
import * as assert from 'assert';

type JsonObject = td.JsonObject;
type JsonBuilder = td.JsonBuilder;

var asArray = td.asArray;

import * as azureTable from "./azure-table"
import * as parallel from "./parallel"
import * as cachedStore from "./cached-store"
import * as indexedStore from "./indexed-store"
import * as core from "./tdlite-core"
import * as audit from "./tdlite-audit"
import * as search from "./tdlite-search"
import * as notifications from "./tdlite-notifications"
import * as tdliteTdCompiler from "./tdlite-tdcompiler"
import * as tdlitePromos from "./tdlite-promos"
import * as tdliteUsers from "./tdlite-users"

var orFalse = core.orFalse;
var withDefault = core.withDefault;
var orEmpty = td.orEmpty;
var logger = core.logger;
var httpCode = core.httpCode;

var updateSlotTable: azureTable.Table;
export var scripts: indexedStore.Store;
var scriptText: cachedStore.Container;
var updateSlots: indexedStore.Store;
var promosTable: azureTable.Table;

var lastShowcaseDl: Date;
var showcaseIds: string[];


export class PubScript
    extends core.TopPub
{
    @td.json public baseid: string = "";
    @td.json public icon: string = "";
    @td.json public iconbackground: string = "";
    @td.json public iconurl: string = "";
    @td.json public cumulativepositivereviews: number = 0;
    @td.json public screenshots: number = 0;
    @td.json public platforms: string[];
    @td.json public capabilities: string[];
    @td.json public flows: string[];
    @td.json public haserrors: boolean = false;
    @td.json public rootid: string = "";
    @td.json public updateid: string = "";
    @td.json public updatetime: number = 0;
    @td.json public ishidden: boolean = false;
    @td.json public islibrary: boolean = false;
    @td.json public installations: number = 0;
    @td.json public runs: number = 0;
    @td.json public art: number = 0;
    @td.json public toptagids: string[];
    @td.json public screenshotthumburl: string = "";
    @td.json public screenshoturl: string = "";
    @td.json public mergeids: string[];
    @td.json public editor: string = "";
    @td.json public meta: JsonObject;
    @td.json public iconArtId: string = "";
    @td.json public splashArtId: string = "";
    @td.json public raw: string = "";
    @td.json public scripthash: string = "";
    @td.json public sourceid: string = "";
    @td.json public updateroot: string = "";
    @td.json public unmoderated: boolean = false;
    @td.json public noexternallinks: boolean = false;
    @td.json public promo: JsonObject;
    static createFromJson(o:JsonObject) { let r = new PubScript(); r.fromJson(o); return r; }
}

export class UpdateEntry
    extends td.JsonRecord
{
    @td.json public PartitionKey: string = "";
    @td.json public RowKey: string = "";
    @td.json public pub: string = "";
    @td.json public time: number = 0;
    static createFromJson(o:JsonObject) { let r = new UpdateEntry(); r.fromJson(o); return r; }
}

export async function resolveScriptsAsync(entities: indexedStore.FetchResult, req: core.ApiRequest, forSearch: boolean) : Promise<void>
{
    let applyUpdates = orFalse(req.queryOptions["applyupdates"]);
    let singleResult = false;
    if (applyUpdates) {
        let updates = {};
        updates[""] = "1";
        entities.items = asArray(entities.items).filter((elt: JsonObject) => {
            if ( ! elt["pub"]["ishidden"]) {
                let key = orEmpty(elt["updateKey"]);
                if (updates[key] == null) {
                    updates[key] = "1";
                    return true;
                }
            }
            return false;
        });
    }
    else if (entities.items.length == 1) {
        singleResult = req.rootId == entities.items[0]["id"];
    }
    // 
    let updateObjs = (<JsonObject[]>[]);
    let srcmapping = {};
    let srcitems = asArray(entities.items);
    let updateIds = srcitems.map<string>(elt1 => withDefault(elt1["updateKey"], "***"));
    updateObjs = await core.pubsContainer.getManyAsync(updateIds);
    if (applyUpdates) {
        let coll2 = updateObjs.map<string>(elt2 => withDefault(elt2["scriptId"], "***"));
        let includeAbuse = true;
        if (forSearch) {
            includeAbuse = core.callerHasPermission(req, "global-list");
        }
        entities.items = (await core.pubsContainer.getManyAsync(coll2))
            .filter(elt3 => core.isGoodPub(elt3, "script") && (includeAbuse || core.isAbuseSafe(elt3)));
        if (forSearch) {
            srcitems.reverse();
            for (let js2 of srcitems) {
                srcmapping[js2["updateKey"]] = js2["id"];
            }
        }
    }
    // 
    await core.addUsernameEtcAsync(entities);
    // 
    let seeHidden = core.hasPermission(req.userinfo.json, "global-list");
    let coll = (<PubScript[]>[]);
    for (let i = 0; i < entities.items.length; i++) {
        let js = entities.items[i];
        let script = PubScript.createFromJson(js["pub"]);
        script.unmoderated = orFalse(script.unmoderated);
        script.noexternallinks = ! core.hasPermission(js["*userid"], "external-links");
        let seeIt = seeHidden || script.userid == req.userid;

        if (script.ishidden) {
            if (script.unmoderated && singleResult) {
                singleResult = core.callerSharesGroupWith(req, js["*userid"]);
            }
            seeIt = seeIt || singleResult || core.callerIsFacilitatorOf(req, js["*userid"]);
            seeIt = seeIt || req.rootId == "promo-scripts" && ! script.unmoderated;
        }
        else if (script.unmoderated) {
            seeIt = seeIt || core.callerSharesGroupWith(req, js["*userid"]);
        }
        else {
            seeIt = true;
        }
        if ( ! seeIt) {
            continue;
        }
        if (forSearch) {
            script.sourceid = withDefault(srcmapping[js["updateKey"]], script.id);
        }
        else {
            script.sourceid = (<string>null);
        }
        if (script == null) {
            logger.error("wrong json: " + JSON.stringify(js));
        }
        if (script.meta == null) {
            script.meta = ({});
        }
        script.promo = js["promo"];
        coll.push(script);
        if (script.rootid == "") {
            script.rootid = script.id;
        }
        let updateObj = updateObjs[i];
        if (updateObj == null) {
            updateObj = ({});
        }
        if (updateObj.hasOwnProperty("scriptTime")) {
            script.updateid = updateObj["scriptId"];
            script.updatetime = updateObj["scriptTime"];
        }
        else {
            script.updateid = script.id;
            script.updatetime = script.time;
        }
        script.updateroot = updateObj["id0"];
        if (script.updateroot == null) {
            script.updateroot = withDefault(updateObj["scriptId"], script.id);
        }
        if (updateObj.hasOwnProperty("pub") && updateObj["pub"].hasOwnProperty("positivereviews")) {
            let count = updateObj["pub"]["positivereviews"];
            script.positivereviews = count;
            script.cumulativepositivereviews = count;
        }
    }
    entities.items = td.arrayToJson(coll);
}

export async function publishScriptCoreAsync(pubScript: PubScript, jsb: JsonBuilder, body: string, req: core.ApiRequest) : Promise<void>
{
    if ( ! jsb.hasOwnProperty("id")) {
        core.progress("publish - gen id, ");
        if (pubScript.ishidden) {
            await core.generateIdAsync(jsb, 10);
        }
        else {
            await core.generateIdAsync(jsb, 6);
        }
    }
    core.progress("publish - gen id done");
    pubScript.id = jsb["id"];
    if (pubScript.rootid == "") {
        pubScript.rootid = pubScript.id;
    }
    // 
    await insertScriptAsync(jsb, pubScript, body, false);
    let jsb2 = td.clone(jsb);
    delete jsb2["text"];
    let scr = td.clone(jsb2);
    await audit.logAsync(req, "publish-script", {
        subjectid: scr["pub"]["userid"],
        publicationid: scr["id"],
        publicationkind: "script",
        newvalue: scr
    });
    core.progress("publish - inserted");
    if (td.stringContains(pubScript.description, "#docs")) {
        logger.tick("CreateHashDocsScript");
    }
    if ( ! pubScript.ishidden) {
        await notifications.storeAsync(req, jsb, "");
        core.progress("publish - notified");
    }
    else {
        logger.tick("New_script_hidden");
    }
}

async function canSeeRootpubScriptAsync(req: core.ApiRequest) : Promise<boolean>
{
    let seeIt2: boolean;
    if (core.hasPermission(req.userinfo.json, "global-list")) {
        return true;
    }
    let scr = PubScript.createFromJson(req.rootPub["pub"]);
    if ( ! orFalse(scr.unmoderated) || scr.userid == req.userid) {
        return true;
    }
    else {
        let entry4 = await tdliteUsers.getAsync(scr.userid);
        return core.callerSharesGroupWith(req, entry4);
    }
    return seeIt2;
}

async function insertScriptAsync(jsb: JsonBuilder, pubScript: PubScript, scriptText_: string, isImport: boolean): Promise<void> {
    pubScript.scripthash = core.sha256(scriptText_).substr(0, 32);
    jsb["pub"] = pubScript.toJson();
    // 
    let updateKey = core.sha256(pubScript.userid + ":" + pubScript.rootid + ":" + pubScript.name);
    let updateEntry = new UpdateEntry();
    updateEntry.PartitionKey = updateKey;
    updateEntry.pub = pubScript.id;
    updateEntry.time = pubScript.time;
    // 
    jsb["updateKey"] = updateKey;
    await scripts.insertAsync(jsb);
    updateEntry.RowKey = jsb["indexId"];
    // 
    let bodyBuilder = td.clone(pubScript.toJson());
    bodyBuilder["text"] = scriptText_;
    core.progress("publish - about to just insert");
    await scriptText.justInsertAsync(pubScript.id, bodyBuilder);
    //
    core.progress("publish - about to update insert2");
    await core.pubsContainer.updateAsync(updateKey, async(entry: JsonBuilder) => {
        if (!entry.hasOwnProperty("id0")) {
            entry["id0"] = withDefault(entry["scriptId"], updateEntry.pub);
        }
        entry["id"] = updateKey;
        if (!entry["pub"])
            entry["pub"] = { positivereviews: 0 };
        let utime = core.orZero(entry["scriptTime"]);
        if ((utime == 0 || (!pubScript.ishidden && utime < updateEntry.time))) {
            entry["scriptId"] = updateEntry.pub;
            entry["scriptTime"] = updateEntry.time;
        }
    });

    jsb["text"] = scriptText_;
    if (!pubScript.ishidden) {
        core.progress("publish - about to update insert");
        await updateSlotTable.insertEntityAsync(updateEntry.toJson(), "or merge");
    }
    await search.scanAndSearchAsync(jsb, {
        skipSearch: pubScript.ishidden,
        skipScan: isImport
    });
}

async function importScriptAsync(req: core.ApiRequest, body: JsonObject) : Promise<void>
{
    let pubScript = new PubScript();
    pubScript.fromJson(core.removeDerivedProperties(body));
    pubScript.screenshotthumburl = "";
    pubScript.iconurl = "";
    pubScript.screenshoturl = "";
    pubScript.capabilities = [];
    pubScript.flows = [];
    pubScript.toptagids = [];
    pubScript.updateid = "";
    pubScript.updatetime = 0;
    pubScript.baseid = orEmpty(pubScript.baseid);
    pubScript.positivereviews = 0;
    pubScript.cumulativepositivereviews = 0;
    pubScript.screenshots = 0;
    if (pubScript.baseid == "" || pubScript.rootid == "") {
        pubScript.rootid = pubScript.id;
    }

    let jsb = {};
    jsb["id"] = pubScript.id;
    await insertScriptAsync(jsb, pubScript, body["text"], true);
}

export async function initAsync() : Promise<void>
{
    updateSlotTable = await core.tableClient.createTableIfNotExistsAsync("scriptupdates");
    scriptText = await cachedStore.createContainerAsync("scripttext", {
        access: "private"
    });
    updateSlots = await indexedStore.createStoreAsync(core.pubsContainer, "updateslot");
    scripts = await indexedStore.createStoreAsync(core.pubsContainer, "script");
    core.registerPubKind({
        store: scripts,
        deleteWithAuthor: true,
        importOne: importScriptAsync,
        specialDeleteAsync: async (entryid:string, delentry:JsonObject) => {
            await scriptText.updateAsync(entryid, async (entry1: JsonBuilder) => {
                for (let fld of Object.keys(entry1)) {
                    delete entry1[fld];
                }
            });
        },
    })
    await core.setResolveAsync(scripts, async (fetchResult: indexedStore.FetchResult, apiRequest: core.ApiRequest) => {
        await resolveScriptsAsync(fetchResult, apiRequest, false);
    }
    , {
        byUserid: true,
        anonSearch: true
    });
    // ### all
    core.addRoute("GET", "language", "*", async (req: core.ApiRequest) => {
        await core.throttleAsync(req, "tdcompile", 20);
        if (req.status == 200) {
            let s = req.origUrl.replace(/^\/api\/language\//g, "");
            await tdliteTdCompiler.forwardToCloudCompilerAsync(req, "language/" + s);
        }
    });
    core.addRoute("GET", "doctopics", "", async (req1: core.ApiRequest) => {
        let resp = await tdliteTdCompiler.queryCloudCompilerAsync("doctopics");
        req1.response = resp["topicsExt"];
    });
    core.addRoute("GET", "*script", "*", async (req2: core.ApiRequest) => {
        let isTd = ! req2.rootPub["pub"]["editor"];
        if ( ! isTd) {
            req2.status = httpCode._405MethodNotAllowed;
        }
        else {
            await core.throttleAsync(req2, "tdcompile", 20);
            if (req2.status == 200) {
                let path = req2.origUrl.replace(/^\/api\/[a-z]+\//g, "");
                await tdliteTdCompiler.forwardToCloudCompilerAsync(req2, "q/" + req2.rootId + "/" + path);
            }
        }
    });
    core.addRoute("POST", "scripts", "", async (req3: core.ApiRequest) => {
        await core.canPostAsync(req3, "direct-script");
        if (req3.status == 200 && orEmpty(req3.body["text"]).length > 200000) {
            req3.status = httpCode._413RequestEntityTooLarge;
        }

        let rawSrc = orEmpty(req3.body["raw"]);
        if (req3.status == 200 && rawSrc != "") {
            core.checkPermission(req3, "post-raw");
        }
        let forceid = orEmpty(req3.body["forceid"]);
        if (req3.status == 200 && forceid != "") {
            core.checkPermission(req3, "pub-mgmt");
        }

        if (req3.status == 200) {
            let scr = new PubScript();
            let entry3 = await core.getPubAsync(orEmpty(req3.body["baseid"]), "script");
            if (entry3 != null) {
                scr.baseid = entry3["id"];
                scr.rootid = entry3["pub"]["rootid"];
            }
            scr.userid = req3.userid;
            scr.mergeids = (<string[]>[]);
            if (req3.body.hasOwnProperty("mergeids")) {
                scr.mergeids = td.toStringArray(req3.body["mergeids"]);
            }
            scr.name = withDefault(req3.body["name"], "unnamed");
            scr.description = orEmpty(req3.body["description"]);
            scr.iconbackground = withDefault(req3.body["iconbackground"], "#FF7518");
            scr.islibrary = orFalse(req3.body["islibrary"]);
            scr.ishidden = orFalse(req3.body["ishidden"]);
            scr.userplatform = core.getUserPlatforms(req3);
            scr.capabilities = (<string[]>[]);
            scr.flows = (<string[]>[]);
            scr.editor = orEmpty(req3.body["editor"]);
            scr.meta = req3.body["meta"];
            if (typeof scr.meta != "object" || Array.isArray(scr.meta))
                scr.meta = {};
            scr.iconArtId = orEmpty(req3.body["iconArtId"]);
            scr.splashArtId = orEmpty(req3.body["splashArtId"]);
            scr.raw = rawSrc;
            scr.unmoderated = ! core.callerHasPermission(req3, "adult");

            let jsb = {};
            if (forceid != "") {
                jsb["id"] = forceid;
            }
            await publishScriptCoreAsync(scr, jsb, td.toString(req3.body["text"]), req3);
            await core.returnOnePubAsync(scripts, td.clone(jsb), req3);
        }
    }
    , {
        sizeCheckExcludes: "text"
    });
    core.addRoute("POST", "*script", "", async (req4: core.ApiRequest) => {
        let unmod = td.toBoolean(req4.body["unmoderated"])
        if (unmod != null) {
            await core.checkFacilitatorPermissionAsync(req4, req4.rootPub["pub"]["userid"]);
            if (req4.status == 200) {
                await core.pubsContainer.updateAsync(req4.rootId, async (entry: JsonBuilder) => {
                    entry["pub"]["unmoderated"] = unmod;
                });
                if ( ! unmod) {
                    await notifications.sendAsync(req4.rootPub, "moderated", (<JsonObject>null));
                }
                req4.response = ({});
            }
        }
        else {
            req4.status = httpCode._400BadRequest;
        }
    });
    core.addRoute("POST", "*script", "meta", async (req5: core.ApiRequest) => {
        if ( ! core.callerHasPermission(req5, "script-promo")) {
            core.checkPubPermission(req5);
        }
        await core.canPostAsync(req5, "script-meta");
        if (req5.status == 200) {
            await core.pubsContainer.updateAsync(req5.rootId, async (v: JsonBuilder) => {
                let meta = v["pub"]["meta"];
                if (meta == null) {
                    meta = {};
                }
                else {
                    meta = td.clone(meta);
                }
                core.copyJson(req5.body, meta);
                for (let k of Object.keys(meta)) {
                    if (meta[k] === null) {
                        delete meta[k];
                    }
                }
                if (JSON.stringify(meta).length > 10000) {
                    req5.status = httpCode._413RequestEntityTooLarge;
                }
                else {
                    v["pub"]["meta"] = meta;
                    req5.response = td.clone(meta);
                }
            });
            if (req5.rootPub["promo"] != null) {
                await core.flushApiCacheAsync("promo");
            }
        }
    });
    core.addRoute("GET", "*script", "text", async (req6: core.ApiRequest) => {
        if (await canSeeRootpubScriptAsync(req6)) {
            let entry2 = await scriptText.getAsync(req6.rootId);
            req6.response = entry2["text"];
        }
        else {
            req6.status = httpCode._402PaymentRequired;
        }
    });
    core.addRoute("GET", "*script", "scripts", async (req6: core.ApiRequest) => {
        // TODO consumers?
        req6.response = {
            items: [],
            continuation: null
        }
    });
    core.addRoute("GET", "*script", "canexportapp", async (req7: core.ApiRequest) => {
        req7.response = ({ canExport: false, reason: "App export not supported in Lite." });
    });
    core.addRoute("GET", "*script", "base", async (req8: core.ApiRequest) => {
        let baseId = req8.rootPub["pub"]["baseid"];
        if (baseId == "") {
            req8.status = 404;
        }
        else {
            req8.response = await core.getOnePubAsync(scripts, baseId, req8);
            if (req8.response == null) {
                req8.status = 404;
            }
        }
    });

    core.addRoute("GET", "showcase-scripts", "", async (req9: core.ApiRequest) => {
        if (!lastShowcaseDl || Date.now() - lastShowcaseDl.getTime() > 20000) {
            let js = await td.downloadJsonAsync("https://tdshowcase.blob.core.windows.net/export/current.json");
            showcaseIds = td.toStringArray(js["ids"]) || [];
            lastShowcaseDl = new Date();
        }
        let entities = await scripts.fetchFromIdListAsync(showcaseIds, req9.queryOptions);
        await core.resolveAsync(scripts, entities, req9);        
        core.buildListResponse(entities, req9);
    });
    core.aliasRoute("GET", "featured-scripts", "showcase-scripts");
    core.aliasRoute("GET", "new-scripts", "scripts");
    core.aliasRoute("GET", "top-scripts", "showcase-scripts");
    // ### by base
    await scripts.createIndexAsync("baseid", entry1 => withDefault(entry1["pub"]["baseid"], "-"));
    core.addRoute("GET", "*script", "successors", async (req10: core.ApiRequest) => {
        await core.anyListAsync(scripts, req10, "baseid", req10.rootId);
    });
    await scripts.createIndexAsync("scripthash", entry4 => entry4["pub"]["scripthash"]);
    core.addRoute("GET", "scripthash", "*", async (req11: core.ApiRequest) => {
        await core.anyListAsync(scripts, req11, "scripthash", req11.verb);
    });
    await scripts.createIndexAsync("updatekey", entry5 => entry5["updateKey"]);
    core.addRoute("GET", "*script", "updates", async (req12: core.ApiRequest) => {
        await core.anyListAsync(scripts, req12, "updatekey", req12.rootPub["updateKey"]);
    });
    await scripts.createIndexAsync("rootid", entry6 => entry6["pub"]["rootid"]);
    core.addRoute("GET", "*script", "family", async (req13: core.ApiRequest) => {
        await core.anyListAsync(scripts, req13, "rootid", req13.rootPub["pub"]["rootid"]);
    });
    
    core.addRoute("POST", "*script", "importfixup", async(req: core.ApiRequest) => {
        if (!core.checkPermission(req, "root")) return;
        let text = orEmpty(req.body["text"]);
        if (!text) {
            req.status = 400;            
            return;
        }
        await scriptText.updateAsync(req.rootId, async(v) => {
            v["text"] = req.body["text"];
        })
        let hash = core.sha256(text).substr(0, 32)
        await scripts.reindexAsync(req.rootId, async(v) => {
            v["pub"]["scripthash"] = hash;
        })
        req.response = { scripthash: hash }
    }, { sizeCheckExcludes: "text" });
    
    if (false)
    core.addRoute("POST", "admin", "reindexscripts", async (req15: core.ApiRequest) => {
        core.checkPermission(req15, "operator");
        if (req15.status == 200) {
            /* async */ scripts.getIndex("all").forAllBatchedAsync("all", 50, async (json) => {
                await parallel.forJsonAsync(json, async (json1: JsonObject) => {
                    let pub = json1["pub"];
                    let r = orFalse(pub["noexternallinks"]);
                    if ( ! r) {
                        let userjson = await tdliteUsers.getAsync(pub["userid"]);
                        if ( ! core.hasPermission(userjson, "external-links")) {
                            logger.debug("noexternallink -> true on " + json1["id"]);
                            await scripts.container.updateAsync(json1["id"], async (entry7: JsonBuilder) => {
                                entry7["pub"]["noexternallinks"] = true;
                            });
                        }
                    }
                });
            });
            req15.response = ({});
        }
    });

    await tdlitePromos.initAsync();
}

async function clearScriptCountsAsync(script: PubScript) : Promise<void>
{
    script.screenshots = 0;
    script.comments = 0;
    await core.pubsContainer.updateAsync(script.id, async (entry: JsonBuilder) => {
        entry["pub"]["screenshots"] = 0;
        entry["pub"]["comments"] = 0;
    });
}

export function getScriptTextAsync(id: string) : Promise<JsonObject>
{
    return scriptText.getAsync(id); 
}

export function getScriptTextsAsync(ids: string[]): Promise<JsonObject[]>
{
    return scriptText.getManyAsync(ids);
}
