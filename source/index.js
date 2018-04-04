const config = require('./config.json');
const exec = require('child_process').exec;
const fs = require('fs');
const path = require('path');
const sizeOf = require('image-size');
const cookie = require('cookie');
const uuidv4 = require('uuid/v4');

const storage = require('@google-cloud/storage');
const gcs = new storage();

const vision = require('@google-cloud/vision');
const client = new vision.ImageAnnotatorClient();

exports.uploadImage = function(req, res) {
    // check the method
    if (req.method !== 'POST') {
        httpError(res, 400, "use POST");
    }
    // parse cookies, get/generate UID
    let cookies = cookie.parse(req.headers.cookie || '');
    let uid = ('UID' in cookies) ? cookies.UID : uuidv4();
    console.log(cookies);
    console.log('UID:', uid);
    // set up the response
    res.setHeader('content-type', 'application/json');
    res.cookie('UID', uid, { maxAge: 999999999 });
    // process the image
    switch (req.get('content-type')) {
        case 'application/json':
            // check required elements
            if (req.body.filename === undefined) {
                return httpError(res, 400, "missing filename");
            }
            if (req.body.data === undefined) {
                return httpError(res, 400, "missing image data");
            }
            // process the image
            let img = decodeBase64Image(req.body.data);
            if (img.data.length > config.MAX_IMAGE_SIZE) {
                return httpError(res, 400, "image too large");
            }
            console.log('image type:', img.type);
            console.log('image size:', img.data.length);
            // upload the file for processing
            let filename = `${uid}/${req.body.filename}`;
            let file = gcs.bucket(config.INPUT_BUCKET).file(filename);
            file.save(img.data, function(err) {
                if (err) {
                    return httpError(res, 500, err);
                }
            });
            break;
        default:
            return httpError(res, 400, "invalid content-type");
    }
    // yay!
    res.status(200).send(JSON.stringify({"status": "OK"}));
};

exports.processImage = function(event) {
    let file = event.data;
    let tempFilename = `/tmp/${path.parse(file.name).base}`;

    return Promise.resolve()
        .then(function() {
            if (file.resourceState === 'not_exists') {
                console.log('deletion event, ignoring..');
                return;
            }
            if (!file.bucket) {
                throw new Error('bucket not provided');
            }
            if (!file.name) {
                throw new Error('filename not provided');
            }
            // download image to temp file
            return gcs.bucket(file.bucket).file(file.name).download({destination: tempFilename})
        })
        .then(function() {
            console.log('downloaded!');
            // find a single face in the photo
            return getSingleFace(tempFilename);
        })
        .then(function(face) {
            console.log('got face!');
            // first pass rotate and scale
            return rotateAndScale(tempFilename, face);
        })
        .then(function(filename) {
            console.log('rotated and scaled!');
            // find face again
            return getSingleFace(tempFilename);
        })
        .then(function(face) {
            console.log('got face again!');
            // compose interim image
            return composeTmpImage(tempFilename, face);
        })
        .then(function(filename) {
            console.log('uploading image!');
            // upload image
            return gcs.bucket(config.TMP_BUCKET).upload(filename, {destination: file.name})
        })
        .then(function() {
            console.log('listing files');
            // fetch the list of files in the tmp bucket
            return gcs.bucket(config.TMP_BUCKET).getFiles();
        })
        /*
        .then(function(data) {
            console.log('fetching files');
            let files = data[0];
            let tmpDir = '/tmp/animate';
            let bucket = gcs.bucket(config.TMP_BUCKET);
            let promises = [[]];
            try {
                fs.mkdirSync(tmpDir);
            } catch(err) {
                //
            }
            files.forEach(function(f) {
                let tmpFile = `${tmpDir}/${path.parse(f.name).base}`;
                console.log(tmpFile);
                promises[0].push(tmpFile);
                promises.push(bucket.file(f.name).download({destination: tmpFile}));
            });
            return Promise.all(promises);
        })
        .then(function(data) {
            console.log('downloded all files!');
            let files = data[0];
            console.log(files);
            let outputFile = '/tmp/animate/out.gif';
            let command = 'convert -loop 0 -delay 10 ' + files.join(' ') + ' ' + outputFile;
            return Promise.all([outputFile, promiseExec(command)]);
        })
        .then(function(data) {
            let outputFile = data[0];
            console.log('animated as', outputFile);
            return gcs.bucket(config.OUTPUT_BUCKET).upload(outputFile, {destination: path.parse(outputFile).base})
        })
        */
        .then(function() {
            console.log(`File ${file.name} processed`);
        })
        .catch(function(err) {
            console.log('processImage error:', err);
        });
};

function httpError(response, statusCode, errorMessage) {
    response.status(statusCode).end(JSON.stringify({"status": "error", "message": errorMessage}));
}

// https://stackoverflow.com/questions/20267939/nodejs-write-base64-image-file
function decodeBase64Image(dataString) {
    let matches = dataString.match(/^data:([A-Za-z-+\/]+);base64,(.+)$/);
    let response = {};
    if (matches.length !== 3) {
        console.log('invalid input string');
        return undefined;
    }
    response.type = matches[1];
    response.data = new Buffer(matches[2], 'base64');
    return response;
}

function composeTmpImage(filename, face) {
    let tempFilename = `${filename}_stage2.png`;
    let command = `convert -size ${config.OUTPUT_WIDTH}x${config.OUTPUT_HEIGHT} xc:black ${tempFilename}`;
    return promiseExec(command)
        .then(function() {
            let xOffset = config.PUPIL_X - face.landmarks.LEFT_EYE_PUPIL.x;
            let yOffset = config.PUPIL_Y - face.landmarks.LEFT_EYE_PUPIL.y;
            let geometry = '' + ((xOffset > 0) ? '+' + xOffset : xOffset) + ((yOffset > 0) ? '+' + yOffset : yOffset);
            let command = `composite -gravity NorthWest -geometry ${geometry} ${filename} ${tempFilename} ${filename}`;
            return promiseExec(command);
        })
        .then(function() {
            return filename;
        });
}

function rotateAndScale(filename, face) {
    let opp = face.landmarks.RIGHT_EYE_PUPIL.y - face.landmarks.LEFT_EYE_PUPIL.y;
    let adj = face.landmarks.RIGHT_EYE_PUPIL.x - face.landmarks.LEFT_EYE_PUPIL.x;
    let hyp = Math.sqrt(Math.pow(Math.abs(adj), 2) + Math.pow(Math.abs(opp), 2));
    let angle = 0 - Math.atan(opp / adj) * (180 / Math.PI);
    let scale = config.PUPIL_DISTANCE / hyp;
    console.log('angle:', angle);

    let dim = sizeOf(filename);
    console.log('size:', dim.width, 'x', dim.height);
    let width = Math.round(dim.width * scale);
    let height = Math.round(dim.height * scale);
    console.log('projected size:', width, 'x', height);

    let command = `mogrify -resize ${width}x${height}\\! -rotate "${angle}" ${filename}`;
    return promiseExec(command)
        .then(function() {
            let dim = sizeOf(filename);
            console.log('new size:', dim.width, 'x', dim.height);
            return filename;
        });
}

function getSingleFace(filename) {
    let request = {image: {source: {filename: filename}}}
    return client.faceDetection(request)
        .then(response => {
            let faces = response[0].faceAnnotations;
            console.log('found ' + faces.length + (faces.length == 1 ? ' face': ' faces'));
            if (faces.length !== 1) {
                throw new Error('Wrong number of faces!');
            }
            let face = faces[0];
            let lm = {};
            face.landmarks.forEach(function(l) {
                lm[l['type']] = l['position'];
            });
            face.landmarks = lm;
            return face;
        });
}

function promiseExec(command) {
    console.log(command);
    return new Promise(function(resolve, reject) {
        exec(command, {stdio: 'ignore'}, function(err, stdout) {
            if (err) {
                reject(err);
            } else {
                resolve();
            }
        });
    });
}
