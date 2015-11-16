/// <reference path='../typings/node/node.d.ts' />

'use strict';

import * as td from './td';
import * as assert from 'assert';
import * as fs from 'fs';

type JsonObject = td.JsonObject;
type JsonBuilder = td.JsonBuilder;


import * as azureTable from "./azure-table"
import * as azureBlobStorage from "./azure-blob-storage"
import * as cachedStore from "./cached-store"
import * as indexedStore from "./indexed-store"
import * as restify from "./restify"
import * as raygun from "./raygun"
import * as loggly from "./loggly"
import * as libratoNode from "./librato-node"
import * as tdliteIndex from "./tdlite-index"
import * as cron from "./cron"

import * as core from "./tdlite-core"
import * as audit from "./tdlite-audit"
import * as search from "./tdlite-search"
import * as notifications from "./tdlite-notifications"
import * as tdliteScripts from "./tdlite-scripts"
import * as tdliteWorkspace from "./tdlite-workspace"
import * as tdliteArt from "./tdlite-art"
import * as tdliteVimeo from "./tdlite-vimeo"
import * as tdliteUsers from "./tdlite-users"
import * as tdliteGroups from "./tdlite-groups"
import * as tdliteComments from "./tdlite-comments"
import * as tdliteReviews from "./tdlite-reviews"
import * as tdliteTags from "./tdlite-tags"
import * as tdliteReleases from "./tdlite-releases"
import * as tdliteTdCompiler from "./tdlite-tdcompiler"
import * as tdlitePointers from "./tdlite-pointers"
import * as tdliteLogin from "./tdlite-login"
import * as tdliteImport from "./tdlite-import"
import * as tdliteCppCompiler from "./tdlite-cppcompiler"
import * as tdliteAbuse from "./tdlite-abuse"
import * as tdliteAdmin from "./tdlite-admin"
import * as tdliteCrashes from "./tdlite-crashes"
import * as tdliteChannels from "./tdlite-channels"
import * as tdliteTicks from "./tdlite-ticks"
import * as tdliteRuntime from "./tdlite-runtime"
import * as tdliteRouting from "./tdlite-routing"
import * as tdliteStatus from "./tdlite-status"
import * as tdliteLegacy from "./tdlite-legacy"
import * as tdliteCounters from "./tdlite-counters"
import * as tdliteProgress from "./tdlite-progress"

var withDefault = core.withDefault;
var orEmpty = td.orEmpty;


var reinit = false;

var logger = core.logger;
var httpCode = restify.http();

async function _initAsync() : Promise<void>
{
    await core.initAsync();

    if (core.myChannel == "live" || core.myChannel == "stage") {
        // never re-init on production instances
        reinit = false;
    }

    if (core.hasSetting("LOGGLY_TOKEN")) {
        await loggly.initAsync({
            globalTags: td.serverSetting("LOG_TAG", false)
        });
    }
    if (core.hasSetting("RAYGUN_API_KEY")) {
        await raygun.initAsync({
            private: !core.fullTD,
            saveReport: tdliteCrashes.saveBugReportAsync,
        });
    }
    if (core.hasSetting("LIBRATO_TOKEN")) {
        let libSource = withDefault(td.serverSetting("RoleInstanceId", true), "local");
        await libratoNode.initAsync({
            period: 60000,
            aggregate: true,
            prefix: td.serverSetting("LIBRATO_PREFIX", true) || ""
        });
        /* async */ tdliteStatus.statusReportLoopAsync();
    } else {
        libratoNode.skipTicks();
    }

    await core.lateInitAsync();

    if (reinit) {
        let success = await core.blobService.setCorsPropertiesAsync("*", "GET,HEAD,OPTIONS", "*", "ErrorMessage,x-ms-request-id,Server,x-ms-version,Content-Type,Cache-Control,Last-Modified,ETag,Content-MD5,x-ms-lease-status,x-ms-blob-type", 3600);
    }
    else {
        azureTable.assumeTablesExists();
        azureBlobStorage.assumeContainerExists();
    }

    let timeDelta = await core.redisClient.cachedTimeAsync() - new Date().getTime();
    logger.info("time difference to redis instance: " + timeDelta + "ms");
    if (false) {
        logger.info(JSON.stringify(await core.redisClient.sendCommandAsync("info", [])));
    }

    await cachedStore.initAsync();
    indexedStore.init(core.tableClient);
    // cachedStore.getLogger().setVerbosity("info");

    let server = restify.server();
    server.use(restify.bodyParser());
    server.use(restify.queryParser());
    server.use(restify.gzipResponse());
    let cors = restify.CORS({
        credentials: true,
        headers: "ErrorMessage"
    });
    server.use(cors);
    restify.disableTicks();
    restify.setupShellHooks();
    
    await initSubsystems();

    if (core.hasSetting("LIBRATO_TOKEN")) {
        /* async */ tdliteStatus.failureReportLoopAsync();
    }
    
    await core.initFinalAsync();

    await restify.startAsync();

    server.get("/api/ping", async (req: restify.Request, res: restify.Response) => {
        core.handleHttps(req, res);
        if ( ! res.finished()) {
            res.send(orEmpty(req.query()["value"]));
        }
    });
    await tdliteLogin.initAsync();
    
    // ## batch api here
    server.post("/api", async(req2: restify.Request, res2: restify.Response) => {
        await core.refreshSettingsAsync();
        cron.poke(); // we're getting requests; it seems we're alive
        await tdliteRouting.performRoutingAsync(req2, res2);
    });
    server.routeRegex("OPTS", ".*", async (req3: restify.Request, res3: restify.Response) => {
        res3.setHeader("Access-Control-Allow-Headers", "Accept, Accept-Version, Content-Type, Origin, X-TD-Access-Token, X-TD-World-ID, X-TD-Release-ID, X-TD-User-Platform, Authorization");
        res3.setHeader("Access-Control-Allow-Credentials", "true");
        res3.setHeader("Access-Control-Max-Age", "3600");
        res3.setHeader("Access-Control-Allow-Methods", "GET, POST, PUT, DELETE, HEAD, OPTIONS");
        res3.sendStatus(200);
    });
    server.all(async(req: restify.Request, res: restify.Response) => {
        await core.refreshSettingsAsync();
        cron.poke(); // we're getting requests; it seems we're alive
        if (td.startsWith(req.url(), "/api/")) {
            await tdliteRouting.performRoutingAsync(req, res);
        }
        else {
            core.handleBasicAuth(req, res);
            if ( ! res.finished() && req.method() != "GET") {
                res.sendError(httpCode._405MethodNotAllowed, "");
            }
            if (!res.finished()) {
                let url = req.url();
                let webappMatch = /^\/users\/@([a-z]+)-[^\/\?]*\/@([a-z]+)-[^\/\?]*($|\?)/.exec(req.url())
                if (webappMatch) {
                    res.redirect(httpCode._301MovedPermanently, "/userapp/" + webappMatch[2])
                }
                else if (url.startsWith("/app/authorize")) {
                    await tdlitePointers.servePointerAsync(req, res);
                } else if (url.startsWith("/app/")) {
                    await tdliteReleases.serveReleaseAsync(req, res);
                } else if (url.startsWith("/userapp/")) {
                    await tdliteReleases.serveWebAppAsync(req, res);
                }
                else if (url.startsWith("/favicon.ico")) {
                    res.sendBuffer(await tdliteReleases.getFaviconAsync(), "image/x-icon");
                }
                else if (url.startsWith("/verify/")) {
                    await tdliteUsers.handleEmailVerificationAsync(req, res);
                }
                else {
                    await tdlitePointers.servePointerAsync(req, res);
                }
            }
        }
    });
    // logger.debug("librato email: " + td.serverSetting("LIBRATO_EMAIL", false));
    
    logger.tick("ServiceStart");
}


async function initSubsystems() : Promise<void>
{
    core.pubsContainer = await cachedStore.createContainerAsync("pubs");    
    core.cachedApiContainer = await cachedStore.createContainerAsync("cachedapi", {
        inMemoryCacheSeconds: 5,
        redisCacheSeconds: 600,
        noBlobStorage: true
    });
    
    core.addRoute("POST", "", "", tdliteRouting.performBatchAsync, { noSizeCheck: true });
    
    await cron.initAsync();
    await tdliteCounters.initAsync([logger.category]);
    
    await audit.initAsync();    
    await tdliteTicks.initAsync();
    await tdliteCrashes.initAsync();
    await tdliteAdmin.initAsync();
    await tdliteScripts.initAsync();
    await tdliteTdCompiler.initAsync();
    await tdliteComments.initAsync()
    await tdliteGroups.initAsync();
    await tdliteTags.initAsync();
    await tdliteArt.initAsync();
    await tdliteReviews.initAsync();
    await tdliteUsers.initAsync();
    await notifications.initAsync();
    await tdliteReleases.initAsync();
    await tdliteAbuse.initAsync();
    await tdliteChannels.initAsync();
    await tdlitePointers.initAsync();
    await tdliteVimeo.initAsync();
    await tdliteRuntime.initAsync();
    await search.initAsync();
    await tdliteImport.initAsync();
    await tdliteWorkspace.initAsync();
    await tdliteCppCompiler.initAsync();
    await tdliteProgress.initAsync();
    if (core.fullTD) {
        await tdliteLegacy.initAsync();
    }    
}


async function main()
{
    if (fs.existsSync(process.argv[2])) {
        var cfg = JSON.parse(fs.readFileSync(process.argv[2], "utf8"))
        Object.keys(cfg).forEach(k => {
            process.env[k] = cfg[k]
        })
        console.log("loaded cfg")
    }
    await _initAsync();    
    // For new int re-deployment
    // await core.redisClient.sendCommandAsync("flushall", []);
    restify.finishStartup();
}

main();
