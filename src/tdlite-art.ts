/// <reference path='../typings/node/node.d.ts' />

'use strict';

import * as td from './td';
import * as assert from 'assert';

type JsonObject = td.JsonObject;
type JsonBuilder = td.JsonBuilder;


import * as azureBlobStorage from "./azure-blob-storage"
import * as parallel from "./parallel"
import * as kraken from "./kraken"
import * as indexedStore from "./indexed-store"
import * as core from "./tdlite-core"
import * as search from "./tdlite-search"
import * as notifications from "./tdlite-notifications"
import * as tdliteIndex from "./tdlite-index"
import * as tdliteSearch from "./tdlite-search"
import * as tdliteData from "./tdlite-data"

var orFalse = core.orFalse;
var withDefault = core.withDefault;
var orEmpty = td.orEmpty;

var logger = core.logger;
var httpCode = core.httpCode;
var arts: indexedStore.Store;
var artContainer: azureBlobStorage.Container;
var thumbContainers: ThumbContainer[] = [];
var aacContainer: azureBlobStorage.Container;
var screenshots: indexedStore.Store;

export class PubArt
    extends core.Publication
{
    @td.json public name: string = "";
    @td.json public description: string = "";
    @td.json public flags: string[];
    @td.json public pictureurl: string = "";
    @td.json public thumburl: string = "";
    @td.json public mediumthumburl: string = "";
    @td.json public wavurl: string = "";
    @td.json public aacurl: string = "";
    @td.json public contenttype: string = "";
    @td.json public bloburl: string = "";
    @td.json public arttype: string = "";
    @td.json public filehash: string = "";
    static createFromJson(o:JsonObject) { let r = new PubArt(); r.fromJson(o); return r; }
}

export class ThumbContainer
{
    public name: string = "";
    public container: azureBlobStorage.Container;
    public size: number = 0;
}

export class PubScreenshot
    extends core.PubOnPub
{
    @td.json public pictureurl: string = "";
    @td.json public thumburl: string = "";
    static createFromJson(o:JsonObject) { let r = new PubScreenshot(); r.fromJson(o); return r; }
}

export async function initAsync() : Promise<void>
{
    if (core.hasSetting("KRAKEN_API_SECRET")) {
        kraken.init("", "");
    }

    artContainer = await core.blobService.createContainerIfNotExistsAsync("pub", "hidden");
    aacContainer = await core.blobService.createContainerIfNotExistsAsync("aac", "hidden");
    await addThumbContainerAsync(128, "thumb");
    await addThumbContainerAsync(512, "thumb1");
    await addThumbContainerAsync(1024, "thumb2");

    arts = await indexedStore.createStoreAsync(core.pubsContainer, "art");
    core.registerPubKind({
        store: arts,
        deleteWithAuthor: true,
        importOne: importArtAsync,
        specialDeleteAsync: deleteArtAsync,
    })
    await core.setResolveAsync(arts, async (fetchResult: indexedStore.FetchResult, apiRequest: core.ApiRequest) => {
        await resolveArtAsync(fetchResult, apiRequest);
    }
    , {
        byUserid: true,
        anonSearch: true
    });
    core.addRoute("POST", "art", "", async (req: core.ApiRequest) => {
        await postArtAsync(req);
    }
    , {
        sizeCheckExcludes: "content"
    });
    core.addRoute("GET", "*script", "art", async (req1: core.ApiRequest) => {
        // TODO implement /<scriptid>/art
        req1.response = ({ "items": [] });
    });
    await arts.createIndexAsync("filehash", entry => orEmpty(entry["pub"]["filehash"]));
    core.addRoute("GET", "arthash", "*", async (req2: core.ApiRequest) => {
        await core.anyListAsync(arts, req2, "filehash", req2.verb);
    });
    
    core.addRoute("POST", "art", "rethumb", rethumbArtsAsync);
    
    core.addRoute("POST", "art", "reindex", async (req2: core.ApiRequest) => {
        core.checkPermission(req2, "operator");
        if (req2.status == 200) {
            await tdliteIndex.clearArtIndexAsync();
            /* async */ arts.getIndex("all").forAllBatchedAsync("all", 100, async (json: JsonObject[]) => {
                let batch = tdliteIndex.createArtUpdate();
                for (let js of await core.addUsernameEtcCoreAsync(json)) {
                    let pub = PubArt.createFromJson(td.clone(js["pub"]));
                    searchIndexArt(pub).upsertArt(batch);
                }
                let statusCode = await batch.sendAsync();
                logger.debug("reindex art, status: " + statusCode);
            });
            req2.status = httpCode._201Created;
        }
    });


    await initScreenshotsAsync();
}

async function initScreenshotsAsync() : Promise<void>
{
    screenshots = await indexedStore.createStoreAsync(core.pubsContainer, "screenshot");
    core.registerPubKind({
        store: screenshots,
        deleteWithAuthor: true,
        importOne: importScreenshotAsync,
        specialDeleteAsync: deleteArtAsync,
    })
    await core.setResolveAsync(screenshots, async (fetchResult: indexedStore.FetchResult, apiRequest: core.ApiRequest) => {
        await resolveScreenshotAsync(fetchResult, apiRequest);
    }
    , {
        byUserid: true,
        byPublicationid: true
    });
    core.addRoute("POST", "screenshots", "", async (req: core.ApiRequest) => {
        await core.canPostAsync(req, "screenshot");
        if (req.status == 200) {
            await postScreenshotAsync(req);
        }
    }
    , {
        sizeCheckExcludes: "content"
    });
}



async function resolveArtAsync(entities: indexedStore.FetchResult, req: core.ApiRequest) : Promise<void>
{
    await core.addUsernameEtcAsync(entities);
    let coll = (<PubArt[]>[]);

    for (let jsb of entities.items) {
        let pubArt = PubArt.createFromJson(jsb["pub"]);
        coll.push(pubArt);
        if (pubArt.flags == null) {
            pubArt.flags = (<string[]>[]);
        }
        let id = "/" + pubArt.id;
        pubArt.contenttype = jsb["contentType"];
        if (req.isUpgrade) {
            queueUpgradeTask(req, /* async */ redownloadArtAsync(jsb));
        }
        if (jsb["isImage"]) {
            pubArt.pictureurl = artContainer.url() + id;
            pubArt.thumburl = thumbContainers[0].container.url() + id;
            pubArt.mediumthumburl = thumbContainers[1].container.url() + id;
            pubArt.bloburl = pubArt.pictureurl;
            pubArt.arttype = "picture";
        }
        else if (! pubArt.arttype || pubArt.arttype == "sound") {
            pubArt.wavurl = artContainer.url() + id;
            if (orFalse(jsb["hasAac"])) {
                pubArt.aacurl = aacContainer.url() + id + ".m4a";
            }
            else {
                pubArt.aacurl = "";
            }
            pubArt.bloburl = withDefault(pubArt.aacurl, pubArt.wavurl);
            pubArt.arttype = "sound";
        }
        else {
            pubArt.bloburl = artContainer.url() + "/" + jsb["filename"];
        }
    }
    await awaitUpgradeTasksAsync(req);
    entities.items = td.arrayToJson(coll);
}

async function postArtAsync(req: core.ApiRequest) : Promise<void>
{
    let ext = getArtExtension(req.body["contentType"]);
    await core.canPostAsync(req, "art");
    core.checkPermission(req, "post-art-" + ext);
    if (req.status != 200) {
        return;
    }
    let pubArt = new PubArt();
    pubArt.name = orEmpty(req.body["name"]);
    pubArt.description = orEmpty(req.body["description"]);
    pubArt.userplatform = core.getUserPlatforms(req);
    pubArt.userid = req.userid;
    pubArt.time = await core.nowSecondsAsync();
    let jsb = {};
    jsb["pub"] = pubArt.toJson();
    jsb["kind"] = "art";
    await postArtLikeAsync(req, jsb);
    if (jsb.hasOwnProperty("existing")) {
        await core.returnOnePubAsync(arts, td.clone(jsb["existing"]), req);
        return;
    }
    if (req.status == 200) {
        await arts.insertAsync(jsb);
        await notifications.storeAsync(req, jsb, "");
        await upsertArtAsync(jsb);
        await search.scanAndSearchAsync(jsb, {
            skipSearch: true
        });
        // ### return art back
        await core.returnOnePubAsync(arts, td.clone(jsb), req);
    }
}

function getArtExtension(contentType: string) : string
{
    let ext: string;
    ext = orEmpty(tdliteData.artContentTypes[orEmpty(contentType)]);
    return ext;
}

async function addThumbContainerAsync(size: number, name: string) : Promise<void>
{
    let thumbContainer2 = new ThumbContainer();
    thumbContainer2.size = size;
    thumbContainer2.name = name;
    thumbContainer2.container = await core.blobService.createContainerIfNotExistsAsync(thumbContainer2.name, "hidden");
    thumbContainers.push(thumbContainer2);
}

async function resolveScreenshotAsync(entities: indexedStore.FetchResult, req: core.ApiRequest) : Promise<void>
{
    await core.addUsernameEtcAsync(entities);
    let coll = (<PubScreenshot[]>[]);
    for (let js of entities.items) {
        let screenshot = PubScreenshot.createFromJson(js["pub"]);
        coll.push(screenshot);
        let id = "/" + screenshot.id;
        screenshot.pictureurl = artContainer.url() + id;
        screenshot.thumburl = thumbContainers[0].container.url() + id;
        if (req.isUpgrade) {
            queueUpgradeTask(req, /* async */ redownloadScreenshotAsync(js));
        }
    }
    await awaitUpgradeTasksAsync(req);
    entities.items = td.arrayToJson(coll);
}

async function updateScreenshotCountersAsync(screenshot: PubScreenshot) : Promise<void>
{
    await core.pubsContainer.updateAsync(screenshot.publicationid, async (entry: JsonBuilder) => {
        core.increment(entry, "screenshots", 1);
    });
}


async function redownloadArtAsync(jsb: JsonObject) : Promise<void>
{
    let urlbase = "https://touchdevelop.blob.core.windows.net/";
    urlbase = "http://cdn.touchdevelop.com/";
    let id = jsb["id"];
    let filename = id;
    let result3 = await core.copyUrlToBlobAsync(artContainer, filename, urlbase + "pub/" + id);
    if (jsb["isImage"]) {
        let result = await core.copyUrlToBlobAsync(thumbContainers[0].container, filename, urlbase + "thumb/" + id);
        if (result == null) {
            result = await core.copyUrlToBlobAsync(thumbContainers[0].container, filename, urlbase + "pub/" + id);
        }
        if (jsb["kind"] == "art") {
            result = await core.copyUrlToBlobAsync(thumbContainers[1].container, filename, urlbase + "thumb1/" + id);
            if (result == null) {
                result = await core.copyUrlToBlobAsync(thumbContainers[1].container, filename, urlbase + "pub/" + id);
            }
        }
    }
    else {
        let result2 = await core.copyUrlToBlobAsync(aacContainer, id + ".m4a", urlbase + "aac/" + id + ".m4a");
    }
}

async function postScreenshotAsync(req: core.ApiRequest) : Promise<void>
{
    let baseKind = req.rootPub["kind"];
    if ( ! /^(script)$/.test(baseKind)) {
        req.status = httpCode._412PreconditionFailed;
    }
    else {
        let screenshot = new PubScreenshot();
        screenshot.userplatform = core.getUserPlatforms(req);
        screenshot.userid = req.userid;
        screenshot.time = await core.nowSecondsAsync();
        screenshot.publicationid = req.rootId;
        screenshot.publicationkind = baseKind;
        screenshot.publicationname = orEmpty(req.rootPub["pub"]["name"]);
        let jsb = {};
        jsb["pub"] = screenshot.toJson();
        await postArtLikeAsync(req, jsb);
        if (req.status == 200) {
            await screenshots.insertAsync(jsb);
            await updateScreenshotCountersAsync(screenshot);
            await notifications.storeAsync(req, jsb, "");
            // ### return screenshot
            await core.returnOnePubAsync(screenshots, td.clone(jsb), req);
        }
    }
}

async function postArtLikeAsync(req: core.ApiRequest, jsb: JsonBuilder) : Promise<void>
{
    let contentType = orEmpty(req.body["contentType"]);
    fixArtProps(contentType, jsb);
    let ext = jsb["ext"];
    let enc = withDefault(req.body["contentEncoding"], "base64");
    if ( ! (enc == "base64" || enc == "utf8")) {
        req.status = httpCode._412PreconditionFailed;
    }
    else if (ext == "") {
        req.status = httpCode._415UnsupportedMediaType;
    }
    else {
        let buf = new Buffer(orEmpty(req.body["content"]), enc);
        let sizeLimit = 1 * 1024 * 1024;
        let arttype = jsb["arttype"];
        if (arttype == "blob") {
            sizeLimit = 8 * 1024 * 1024;
        }
        else if (arttype == "video") {
            sizeLimit = 8 * 1024 * 1024;
        }
        if (buf == null) {
            req.status = httpCode._400BadRequest;
        }
        else if (buf.length > sizeLimit) {
            req.status = httpCode._413RequestEntityTooLarge;
        }
        else {
            let sha = td.sha256(buf).substr(0, 32);
            jsb["pub"]["filehash"] = sha;
            if (orEmpty(jsb["kind"]) == "art" && ! orFalse(req.body["forcenew"])) {
                let fetchResult = await arts.getIndex("filehash").fetchAsync(sha, ({}));
                let existing = fetchResult.items[0];
                if (existing != null) {
                    jsb["existing"] = existing;
                    return;
                }
            }
            await core.generateIdAsync(jsb, 8);
            let filename = jsb["id"];
            if (arttype == "blob" || arttype == "text") {
                let s = orEmpty(jsb["pub"]["name"]).replace(/[^a-zA-Z0-9]+/g, "-").replace(/^-+/g, "").replace(/-+$/g, "");
                filename = filename + "/" + withDefault(s, "file") + "." + ext;
            }
            jsb["filename"] = filename;
            let result = await artContainer.createGzippedBlockBlobFromBufferAsync(filename, buf, {
                forceNew: true,
                contentType: contentType,
                cacheControl: "public, max-age=900",
                smartGzip: true
            });
            if ( ! result.succeded()) {
                req.status = httpCode._424FailedDependency;
            }
            else if (jsb["isImage"]) {
                await rethumbOneAsync(req, filename, contentType);
            }
        }
    }
}

async function rethumbOneAsync(req: core.ApiRequest, filename: string, contentType: string) {
    let url = artContainer.url() + "/" + filename;
    await parallel.forAsync(thumbContainers.length, async(i: number) => {
        let thumbContainer = thumbContainers[i];
        let tempThumbUrl = await kraken.optimizePictureUrlAsync(url, {
            width: thumbContainer.size,
            height: thumbContainer.size,
            resizeStrategy: "auto",
            lossy: true,
            quality: 60
        });
        if (tempThumbUrl != null) {
            let result2 = await thumbContainer.container.createBlockBlobFromUrlAsync(filename, tempThumbUrl, {
                forceNew: false,
                contentType: contentType,
                cacheControl: "public, max-age=900",
                timeoutIntervalInMs: 3000
            });
            if (!result2.succeded()) {
                req.status = httpCode._424FailedDependency;
            }
        }
        else {
            req.status = httpCode._400BadRequest;
        }
    });
}

async function rethumbArtsAsync(req: core.ApiRequest)
{
    if (!core.checkPermission(req, "operator"))
        return;    
    let fr = await arts.fetchFromIdListAsync(req.argument.split(/,/).filter(e => !!e), {});    
    await resolveArtAsync(fr, req);
    let msgs = []
    await parallel.forJsonAsync(fr.items, async(pub) => {
        let art = PubArt.createFromJson(pub);
        if (art.arttype == "picture") {
            msgs.push(`rethumb: ${art.id} -> ${JSON.stringify(pub) }`)
            await rethumbOneAsync(req, art.id, art.contenttype);
        }
    }, 5);
    req.response = {
        msgs: msgs
    }
}

async function redownloadScreenshotAsync(js: JsonObject) : Promise<void>
{
    await redownloadArtAsync(js);
    await core.pubsContainer.updateAsync(js["id"], async (entry: JsonBuilder) => {
        fixArtProps("image/jpeg", entry);
    });
}

async function importArtAsync(req: core.ApiRequest, body: JsonObject) : Promise<void>
{
    let pubArt = new PubArt();
    pubArt.fromJson(core.removeDerivedProperties(body));
    let contentType = "";
    let urlToDownload = orEmpty(pubArt.pictureurl);
    if (urlToDownload != "") {
        let wreq = td.createRequest(urlToDownload);
        wreq.setMethod("head");
        let response = await wreq.sendAsync();
        if (response.statusCode() == 200) {
            contentType = response.header("content-type");
        }
        else {
            logger.error("cannot HEAD art resource: " + urlToDownload);
            req.status = 404;
        }
    }
    else if (orEmpty(pubArt.wavurl) != "") {
        contentType = "audio/wav";
        urlToDownload = pubArt.wavurl;
    }
    else {
        logger.error("bad art import: " + JSON.stringify(body));
        req.status = 500;
    }
    logger.debug("content type: " + contentType + " for " + pubArt.id);
    if (req.status == 200) {
        let jsb = {};
        jsb["pub"] = pubArt.toJson();
        jsb["id"] = pubArt.id;
        fixArtProps(contentType, jsb);
        // 
        let fn = pubArt.id;
        let result3 = await core.copyUrlToBlobAsync(artContainer, fn, urlToDownload);
        if (result3 == null) {
            logger.error("cannot download art blob: " + JSON.stringify(pubArt.toJson()));
            req.status = 500;
        }
        else if ( ! result3.succeded()) {
            logger.error("cannot create art blob: " + JSON.stringify(pubArt.toJson()));
            req.status = 500;
        }
        else if (jsb["isImage"]) {
            let result4 = await core.copyUrlToBlobAsync(thumbContainers[0].container, fn, withDefault(pubArt.thumburl, urlToDownload));
            let result5 = await core.copyUrlToBlobAsync(thumbContainers[1].container, fn, withDefault(pubArt.mediumthumburl, urlToDownload));
            if (result5 == null || result4 == null) {
                logger.error("cannot download art blob thumb: " + JSON.stringify(pubArt.toJson()));
                req.status = httpCode._206PartialContent;
            }   
            else if ( ! result4.succeded() || ! result5.succeded()) {
                logger.error("cannot create art blob thumb: " + JSON.stringify(pubArt.toJson()));
                req.status = 500;
            }

        }
        else if (orEmpty(pubArt.aacurl) != "") {
            let result41 = await core.copyUrlToBlobAsync(aacContainer, pubArt.id + ".m4a", pubArt.aacurl);
            logger.debug("copy audio url OK for " + pubArt.id);
            if (result41 == null || ! result41.succeded()) {
                logger.error("cannot create art blob aac: " + JSON.stringify(pubArt.toJson()));
                req.status = 500;
            }
            else {
                jsb["hasAac"] = true;
            }
        }
        // 
        if (req.status == 200 || req.status == httpCode._206PartialContent) {
            await arts.insertAsync(jsb);
            await upsertArtAsync(jsb);
            logger.debug("insert OK " + pubArt.id);
        }
    }
}

function fixArtProps(contentType: string, jsb: JsonBuilder) : void
{
    let ext = getArtExtension(contentType);
    jsb["ext"] = ext;
    jsb["contentType"] = contentType;
    let arttype = "blob";
    if (ext == "jpg" || ext == "png") {
        arttype = "picture";
    }
    else if (ext == "wav" || ext == "mp3" || ext == "aac") {
        arttype = "sound";
    }
    else if (ext == "js" || /^text\//.test(contentType)) {
        arttype = "text";
    }
    else if (ext == "mp4") {
        arttype = "video";
    }
    if (ext == "") {
        arttype = "";
    }
    jsb["isImage"] = arttype == "picture";
    jsb["arttype"] = arttype;
    jsb["pub"]["arttype"] = arttype;
}

async function importScreenshotAsync(req: core.ApiRequest, body: JsonObject) : Promise<void>
{
    let screenshot = new PubScreenshot();
    screenshot.fromJson(core.removeDerivedProperties(body));
    let r = orEmpty(screenshot.pictureurl);
    let jsb = {};
    jsb["pub"] = screenshot.toJson();
    jsb["id"] = screenshot.id;
    fixArtProps("image/jpeg", jsb);
    // 
    let fn = screenshot.id;
    let result3 = await core.copyUrlToBlobAsync(artContainer, fn, r);
    if (result3 == null || ! result3.succeded()) {
        logger.error("cannot create ss blob: " + JSON.stringify(screenshot.toJson()));
        req.status = 500;
    }

    if (req.status == 200) {
        let result4 = await core.copyUrlToBlobAsync(thumbContainers[0].container, fn, withDefault(screenshot.thumburl, r));
        if (result4 == null) {
            logger.error("cannot download ssblob thumb: " + JSON.stringify(screenshot.toJson()));
            req.status = 404;
        }
        else if ( ! result4.succeded()) {
            logger.error("cannot create ssblob thumb: " + JSON.stringify(screenshot.toJson()));
            req.status = 500;
        }
    }
    // 
    if (req.status == 200) {
        await screenshots.insertAsync(jsb);
        logger.debug("insert OK " + screenshot.id);
        await updateScreenshotCountersAsync(screenshot);
    }
}

async function deleteArtAsync(entryid:string, entry:JsonObject)
{
    await artContainer.deleteBlobAsync(entryid);
    for (let thumbContainer of thumbContainers) {
        await thumbContainer.container.deleteBlobAsync(entryid);
    }
}

export function hasThumbContainer(name:string)
{
    return thumbContainers.some(e => e.name == name);
}

function searchIndexArt(pub: PubArt) : tdliteIndex.ArtEntry
{
    let entry: tdliteIndex.ArtEntry;
    let tp = "picture";
    if (! pub.pictureurl) {
        tp = "sound";
    }
    let spr = false;
    if (pub.flags != null) {
        spr = pub.flags.indexOf("transparent") >= 0;
    }
    entry = tdliteIndex.createArtEntry(pub.id, {
        name: pub.name,
        description: pub.description,
        type: tp,
        userid: pub.userid,
        username: pub.username,
        sprite: spr
    });
    return entry;
}

export async function upsertArtAsync(obj: JsonBuilder) : Promise<void>
{
    if (tdliteSearch.disableSearch) {
        return;
    }
    let batch = tdliteIndex.createArtUpdate();
    let coll2 = await core.addUsernameEtcCoreAsync(arts.singleFetchResult(td.clone(obj)).items);
    let pub = PubArt.createFromJson(td.clone(coll2[0]["pub"]));
    searchIndexArt(pub).upsertArt(batch);
    /* async */ batch.sendAsync();

    await tdliteSearch.scanAndSearchAsync(obj, {
        skipScan: true
    });
}

function queueUpgradeTask(req: core.ApiRequest, task:Promise<void>) : void
{
    if (req.upgradeTasks == null) {
        req.upgradeTasks = [];
    }
    req.upgradeTasks.push(task);
}

async function awaitUpgradeTasksAsync(req: core.ApiRequest) : Promise<void>
{
    if (req.upgradeTasks != null) {
        for (let task2 of req.upgradeTasks) {
            await task2;
        }
    }
}

export function getBlobUrl(artjs: {})
{
    return artContainer.url() + "/" + artjs["filename"];
}
