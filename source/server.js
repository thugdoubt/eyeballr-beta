"use strict";

const config = require("./config.json");
const path = require("path");
const express = require("express");
const session = require("express-session");
const bodyParser = require("body-parser");
const uuidv4 = require("uuid/v4");

let gcpCredentials = {
    projectId: config.PROJECT_ID,
    keyFilename: "/opt/eyeballr/gcp-credentials.json"
};

const datastore = require("@google-cloud/datastore");
const datastoreStore = require("@google-cloud/connect-datastore")(session);

const storage = require("@google-cloud/storage");
const gcs = new storage(gcpCredentials);

const pubsub = require("@google-cloud/pubsub");
const gcps = new pubsub(gcpCredentials);

const app = express();
app.use(bodyParser.json({limit: config.JSON_REQUEST_LIMIT}));

gcpCredentials.prefix = config.DATASTORE_PREFIX;
app.set('trust proxy', 1);
app.use(session({
    store: new datastoreStore({
        dataset: datastore(gcpCredentials)
    }),
    secret: config.SESSION_SECRET,
    resave: false,
    saveUninitialized: true,
    cookie: {
        secure: config.COOKIE_SECURE,
        maxAge: config.COOKIE_MAX_AGE
    },
    name: config.COOKIE_NAME
}));

function httpError(response, statusCode, errorMessage) {
    response.status(statusCode).end(JSON.stringify({"status": "error", "message": errorMessage}));
}

// https://stackoverflow.com/questions/20267939/nodejs-write-base64-image-file
function decodeBase64Image(dataString) {
    console.log("decoding image:", dataString.substring(0, 30));
    let matches = dataString.match(/^data:([A-Za-z-\+\/]+);base64,(.+)$/m);
    let response = {};
    if (!matches) {
        console.log("malformed content");
        return undefined;
    }
    if (matches.length !== 3) {
        console.log("invalid input string");
        return undefined;
    }
    response.type = matches[1];
    response.data = new Buffer(matches[2], "base64");
    return response;
}

class Eyeballr {
    constructor(ticket) {
        this.ticket = ticket;
    }

    // add an image
    upload(filename, filedata, metadata) {
        let file = gcs.bucket(config.INPUT_BUCKET).file(filename);
        return file.save(filedata)
            .then(function() {
                return file.setMetadata({'metadata': metadata});
            });
    }

    // merge is ready when there are zero input files
    // and more than 1 interim file
    ready() {
        let input = 0,
            tmp = 0,
            ticket = this.ticket;
        return Promise.all([
                gcs.bucket(config.INPUT_BUCKET).getFiles({prefix: ticket}).then(function(f) { return f[0].length }),
                gcs.bucket(config.TMP_BUCKET).getFiles({prefix: ticket}).then(function(f) { return f[0].length })
            ]).then(function(counts) {
                console.log(counts);
                return counts[0] == 0 && counts[1] > 1;
            });
    }

    // merge the processed images into a single image
    merge() {
        return gcps
            .topic(config.TOPIC_NAME)
            .publisher()
            .publish(Buffer.from(this.ticket), {})
            .then(function(results) {
                let messageId = results[0];
                console.log(`Published message ${messageId}`);
            });
    }

    // is the merge complete?
    complete() {
        let count = 0,
            ticket = this.ticket;
        return gcs.bucket(config.OUTPUT_BUCKET).getFiles({prefix: ticket}).then(function(f) { return f[0].length })
            .then(function(count) {
                console.log(count);
                return count > 0;
            });
    }
};

app.get("/ok", function(req, res) {
    // healthcheck
    console.log("OK");
    res.send("eyeballr OK");
});

app.get("/api/ping", function(req, res) {
    // testing stuff
    console.log("PONG");
    res.send("eyeballr PONG");
});

app.get("/api/v0/ticket", function(req, res) {
    let ticket = req.session.ticket ? req.session.ticket : uuidv4();
    req.session.ticket = ticket;
    res.status(200).end(JSON.stringify({"status": "OK", "ticket": ticket}));
});

app.post("/api/v0/upload/:ticket", function(req, res) {
    console.log("UPLOAD");
    try {
        // set up the response
        res.setHeader("content-type", "application/json");

        // check the ticket
        let ticket = req.params.ticket;
        if (ticket !== req.session.ticket) {
            return httpError(res, 500, "invalid ticket");
        }
        console.log('TICKET: ' + ticket);

        // process the image
        switch (req.get("content-type")) {
            case "application/json":
                // check required elements
                if (req.body.filename === undefined) {
                    return httpError(res, 400, "missing filename");
                }
                if (req.body.data === undefined) {
                    return httpError(res, 400, "missing image data");
                }
                // process the image
                let img = decodeBase64Image(req.body.data);
                if (img === undefined) {
                    return httpError(res, 400, "invalid image data");
                }
                if (img.data.length > config.MAX_IMAGE_SIZE) {
                    return httpError(res, 400, "image too large");
                }
                console.log("image type:", img.type);
                console.log("image size:", img.data.length);
                // upload the file for processing
                let filename = `${ticket}/${path.parse(req.body.filename).base}`;
                let file = gcs.bucket(config.INPUT_BUCKET).file(filename);
                let eb = new Eyeballr(ticket);
                let metadata = {ticket: ticket,
                                filename: req.body.filename,
                                cas: req.body.cas || false};
                console.log('metadata:', metadata);
                eb.upload(filename, img.data, metadata);
                break;
            default:
                return httpError(res, 400, "invalid content-type");
        }
        // yay!
        res.status(200).end(JSON.stringify({"status": "OK"}));
    } catch(err) {
        return httpError(res, 500, "OOPS: " + err);
    }
});

app.get("/api/v0/ready/:ticket", function(req, res) {
    console.log("MERGEREADY");
    try {
        // set up the response
        res.setHeader("content-type", "application/json");

        // check the ticket
        let ticket = req.params.ticket;
        if (ticket !== req.session.ticket) {
            return httpError(res, 500, "invalid ticket");
        }
        console.log('TICKET: ' + ticket);

        // check to see if merging is ready
        let eb = new Eyeballr(ticket);
        eb.ready()
            .then(function(ready) {
                res.status(200).end(JSON.stringify({"ready": ready}));
            });
    } catch(err) {
        return httpError(res, 500, "OOPS: " + err);
    }
});

app.post("/api/v0/merge/:ticket", function(req, res) {
    console.log("MERGE");
    try {
        // set up the response
        res.setHeader("content-type", "application/json");

        // check the ticket
        let ticket = req.params.ticket;
        if (ticket !== req.session.ticket) {
            return httpError(res, 500, "invalid ticket");
        }
        console.log('TICKET: ' + ticket);

        let eb = new Eyeballr(ticket);
        if (eb.ready()) {
            // yay!
            eb.merge()
                .then(function() {
                    res.status(200).end(JSON.stringify({"status": "OK"}));
                });
        } else {
            httpError(res, 503, 'Not yet ready');
        }
    } catch(err) {
        return httpError(res, 500, "OOPS: " + err);
    }
});

app.get("/api/v0/complete/:ticket", function(req, res) {
    console.log("COMPLETEREADY");
    try {
        // set up the response
        res.setHeader("content-type", "application/json");

        // check the ticket
        let ticket = req.params.ticket;
        if (ticket !== req.session.ticket) {
            return httpError(res, 500, "invalid ticket");
        }
        console.log('TICKET: ' + ticket);

        // check to see if merging is ready
        let eb = new Eyeballr(ticket);
        let url = `https://storage.googleapis.com/${config.OUTPUT_BUCKET}/${ticket}/out.gif`;
        eb.complete()
            .then(function(ready) {
                res.status(200).end(JSON.stringify({"complete": ready, "url": url}));
            });
    } catch(err) {
        return httpError(res, 500, "OOPS: " + err);
    }
});

app.listen(config.API_PORT, config.API_HOST);
console.log(`running on http://${config.API_HOST}:${config.API_PORT}`);
