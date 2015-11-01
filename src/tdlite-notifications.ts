/// <reference path='../typings/node/node.d.ts' />

'use strict';

import * as td from './td';
import * as assert from 'assert';

type JsonObject = td.JsonObject;
type JsonBuilder = td.JsonBuilder;


import * as azureTable from "./azure-table"
import * as parallel from "./parallel"
import * as cachedStore from "./cached-store"
import * as indexedStore from "./indexed-store"
import * as core from "./tdlite-core"
import * as tdliteUsers from "./tdlite-users"
import * as tdliteGroups from "./tdlite-groups"


var orEmpty = td.orEmpty;
var logger = core.logger;

var subscriptions: indexedStore.Store;
var notificationsTable: azureTable.Table;

export class PubSubscription
    extends core.PubOnPub
{
    static createFromJson(o:JsonObject) { let r = new PubSubscription(); r.fromJson(o); return r; }
}

export class PubNotification
    extends core.PubOnPub
{
    @td.json public notificationkind: string = "";
    @td.json public supplementalid: string = "";
    @td.json public supplementalkind: string = "";
    @td.json public supplementalname: string = "";
    static createFromJson(o:JsonObject) { let r = new PubNotification(); r.fromJson(o); return r; }
}

export async function storeAsync(req: core.ApiRequest, jsb: JsonBuilder, subkind: string) : Promise<void>
{
    let pub = jsb["pub"];
    let userid = pub["userid"];
    let pubkind = pub["kind"];
    logger.tick("New_" + pubkind);
    if (pubkind == "abusereport") {
        userid = pub["publicationuserid"];
    }
    let toNotify = {}
    if (pubkind != "review") {
        for (let sub of await subscriptions.getIndex("publicationid").fetchAllAsync(userid)) {
            toNotify[sub["pub"]["userid"]] = "subscribed";
        }
        for (let grJson of await tdliteGroups.getUser_sGroupsAsync(userid)) {
            let gr = tdliteGroups.PubGroup.createFromJson(grJson["pub"]);
            if (gr.isclass && gr.userid != userid) {
                toNotify[gr.userid] = "class";
            }
            if (pubkind != "abusereport") {
                toNotify[gr.id] = "group";
            }
        }
    }
    if (req.rootPub != null) {
        let parentUserid = req.rootPub["pub"]["userid"];
        let parentKind = req.rootPub["kind"];
        if (parentUserid != userid) {
            if (pubkind == "script") {
                toNotify[parentUserid] = "fork";
            }
            else if (pubkind == "comment") {
                if (parentKind == "comment") {
                    toNotify[parentUserid] = "reply";
                }
                else {
                    toNotify[parentUserid] = "onmine";
                }
            }
            else {
                toNotify[parentUserid] = "onmine";
            }
        }
    }
    toNotify["all"] = "all";

    if (Object.keys(toNotify).length > 0) {
        let notification = new PubNotification();
        notification.kind = "notification";
        notification.id = (await cachedStore.invSeqIdAsync()).toString();
        notification.time = pub["time"];
        notification.publicationid = pub["id"];
        notification.publicationkind = pubkind;
        notification.publicationname = orEmpty(pub["name"]);
        if (req.rootPub != null) {
            notification.supplementalid = req.rootPub["id"];
            notification.supplementalkind = req.rootPub["kind"];
            notification.supplementalname = orEmpty(req.rootPub["pub"]["name"]);
        }
        notification.userid = userid;

        let jsb2 = td.clone(notification.toJson());
        jsb2["RowKey"] = notification.id;

        let ids = Object.keys(toNotify);
        await parallel.forAsync(ids.length, async (x: number) => {
            let id = ids[x];
            let jsb3 = td.clone(jsb2);
            jsb3["PartitionKey"] = id;
            jsb3["notificationkind"] = toNotify[id];
            await notificationsTable.insertEntityAsync(td.clone(jsb3), "or merge");
            if (id != "all") {                 
                await core.pubsContainer.updateAsync(id, async(entry: JsonBuilder) => {
                    // this may be a user or a group
                    let num = core.orZero(entry["notifications"]);
                    entry["notifications"] = num + 1;
                });
            }
            await core.pokeSubChannelAsync("notifications:" + id);
            await core.pokeSubChannelAsync("installed:" + id);
        });
    }
}

export async function initAsync() : Promise<void>
{
    let notTableClient = await core.specTableClientAsync("NOTIFICATIONS");
    notificationsTable = await notTableClient.createTableIfNotExistsAsync("notifications2");
    subscriptions = await indexedStore.createStoreAsync(core.pubsContainer, "subscription");
    await core.setResolveAsync(subscriptions, async (fetchResult: indexedStore.FetchResult, apiRequest: core.ApiRequest) => {
        let field = "userid";
        if (apiRequest.verb == "subscriptions") {
            field = "publicationid";
        }
        let users = await core.followPubIdsAsync(fetchResult.items, field, "user");
        fetchResult.items = td.arrayToJson(users);
        tdliteUsers.resolveUsers(fetchResult, apiRequest);
    }
    , {
        byUserid: true,
        byPublicationid: true
    });
    // Note that it logically should be ``subscribers``, but we use ``subscriptions`` for backward compat.
    core.addRoute("POST", "*user", "subscriptions", async (req: core.ApiRequest) => {
        await core.canPostAsync(req, "subscription");
        if (req.status == 200) {
            await addSubscriptionAsync(req.userid, req.rootId);
            req.response = ({});
        }
    });
    core.addRoute("DELETE", "*user", "subscriptions", async (req1: core.ApiRequest) => {
        await core.canPostAsync(req1, "subscription");
        if (req1.status == 200) {
            await removeSubscriptionAsync(req1.userid, req1.rootId);
            req1.response = ({});
        }
    });
    core.addRoute("GET", "*pub", "notifications", async (req2: core.ApiRequest) => {
        await getNotificationsAsync(req2, false);
    });
    core.addRoute("GET", "notifications", "", async (req3: core.ApiRequest) => {
        req3.rootId = "all";
        await getNotificationsAsync(req3, false);
    });
    core.addRoute("GET", "*pub", "notificationslong", async (req4: core.ApiRequest) => {
        await getNotificationsAsync(req4, true);
    });
    core.addRoute("GET", "notificationslong", "", async (req5: core.ApiRequest) => {
        req5.rootId = "all";
        await getNotificationsAsync(req5, true);
    });
    core.addRoute("POST", "*user", "notifications", async (req6: core.ApiRequest) => {
        core.meOnly(req6);
        if (req6.status == 200) {
            let resQuery2 = notificationsTable.createQuery().partitionKeyIs(req6.rootId).top(1);
            let entities2 = await resQuery2.fetchPageAsync();
            let js = entities2.items[0];
            let topNot = "";
            if (js != null) {
                topNot = js["RowKey"];
            }
            let resp = {};
            resp["lastNotificationId"] = orEmpty(req6.rootUser().lastNotificationId);
            await tdliteUsers.updateAsync(req6.rootId, async (entry) => {
                entry.lastNotificationId = topNot;
                entry.notifications = 0;
            });
            req6.response = td.clone(resp);
        }
    });
}

async function addSubscriptionAsync(follower: string, celebrity: string) : Promise<void>
{
    let sub = new PubSubscription();
    sub.id = "s-" + follower + "-" + celebrity;
    if (follower != celebrity && await core.getPubAsync(sub.id, "subscription") == null) {
        sub.userid = follower;
        sub.time = await core.nowSecondsAsync();
        sub.publicationid = celebrity;
        sub.publicationkind = "user";
        let jsb = {};
        jsb["pub"] = sub.toJson();
        jsb["id"] = sub.id;
        await subscriptions.insertAsync(jsb);
        await tdliteUsers.updateAsync(sub.publicationid, async (entry) => {
            core.increment(entry, "subscribers", 1);
        });
    }
}


async function removeSubscriptionAsync(follower: string, celebrity: string) : Promise<void>
{
    let subid = "s-" + follower + "-" + celebrity;
    let entry2 = await core.getPubAsync(subid, "subscription");
    if (entry2 != null) {
        let delok = await core.deleteAsync(entry2);
        if (delok) {
            await tdliteUsers.updateAsync(celebrity, async (entry) => {
                core.increment(entry, "subscribers", -1);
            });
        }
    }
}

async function getNotificationsAsync(req: core.ApiRequest, long: boolean) : Promise<void>
{
    if (req.rootId == "all") {
        core.checkPermission(req, "global-list");
    }
    else if (req.rootPub["kind"] == "group") {
        let pub = req.rootPub["pub"];
        if (pub["isclass"]) {
            let b = req.userinfo.json.groups.hasOwnProperty(pub["id"]);
            if ( ! b) {
                core.checkPermission(req, "global-list");
            }
        }
    }
    else {
        core.meOnly(req);
    }
    if (req.status != 200) {
        return;
    }
    let v = await core.longPollAsync("notifications:" + req.rootId, long, req);
    if (req.status == 200) {
        let resQuery = notificationsTable.createQuery().partitionKeyIs(req.rootId);
        let entities = await indexedStore.executeTableQueryAsync(resQuery, req.queryOptions);
        entities.v = v;
        req.response = entities.toJson();
    }
}

export async function sendAsync(about: JsonObject, notkind: string, suplemental: JsonObject) : Promise<void>
{
    let notification = new PubNotification();
    notification.kind = "notification";
    notification.id = (await cachedStore.invSeqIdAsync()).toString();
    let pub = about["pub"];
    notification.time = pub["time"];
    notification.publicationid = pub["id"];
    notification.publicationkind = pub["kind"];
    notification.publicationname = orEmpty(pub["name"]);
    notification.userid = pub["userid"];
    if (notkind == "groupapproved") {
        notification.userid = suplemental["id"];
    }
    notification.notificationkind = notkind;
    if (suplemental != null) {
        notification.supplementalid = suplemental["id"];
        notification.supplementalkind = suplemental["kind"];
        notification.supplementalname = suplemental["pub"]["name"];
    }
    let target = notification.userid;
    let jsb2 = notification.toJson();
    jsb2["PartitionKey"] = target;
    jsb2["RowKey"] = notification.id;
    await notificationsTable.insertEntityAsync(td.clone(jsb2), "or merge");
    await tdliteUsers.updateAsync(target, async(entry) => {
        // target is always user
        entry.notifications++;
    });
    await core.pokeSubChannelAsync("notifications:" + target);
    await core.pokeSubChannelAsync("installed:" + target);
}

