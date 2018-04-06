"use strict";

const config = require("./config.json");
const path = require("path");
const express = require("express");
const bodyParser = require("body-parser");
const cookie = require("cookie");
const uuidv4 = require("uuid/v4");

const storage = require("@google-cloud/storage");
const gcs = new storage({projectId:"eyeballr-beta", keyFilename: "/opt/eyeballr/gcp-credentials.json"});

const app = express();
app.use(bodyParser.json({limit: config.JSON_REQUEST_LIMIT}));

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

app.get("/api/v0/upload", function(req, res) {
    return httpError(res, 400, "use POST");
});

app.post("/api/v0/upload", function(req, res) {
    // check the method
    console.log("UPLOAD");
    try {
        // parse cookies, get/generate UID
        console.log(req.headers);
        let cookies = cookie.parse(req.headers.cookie || "");
        let uid = ("UID" in cookies) ? cookies.UID : uuidv4();
        console.log("UID:", uid);
        // set up the response
        res.setHeader("content-type", "application/json");
        res.cookie("UID", uid, { maxAge: 999999999 });
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
                let filename = `${uid}/${path.parse(req.body.filename).base}`;
                let file = gcs.bucket(config.INPUT_BUCKET).file(filename);
                file.save(img.data, function(err) {
                    if (err) {
                        throw new Error("Unable to save: " + err);
                    }
                });
                break;
            default:
                return httpError(res, 400, "invalid content-type");
        }
    } catch(err) {
        return httpError(res, 500, "OOPS: " + err);
    }
    // yay!
    res.status(200).end(JSON.stringify({"status": "OK"}));
});

app.listen(config.API_PORT, config.API_HOST);
console.log(`running on http://${config.API_HOST}:${config.API_PORT}`);
