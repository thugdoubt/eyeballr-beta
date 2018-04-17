const config = require('./config.json');
const exec = require('child_process').exec;
const fs = require('fs');
const path = require('path');
const sizeOf = require('image-size');

const storage = require('@google-cloud/storage');
const gcs = new storage();

const vision = require('@google-cloud/vision');
const client = new vision.ImageAnnotatorClient();

exports.processImage = function(event) {
    let file = event.data;
    let p = path.parse(file.name);
    let ticket = path.basename(p.dir);
    let basename = p.base;
    let tempDir = `${config.TMP_DIR}/${ticket}`;
    let tempFilename = `${tempDir}/${basename}`;
    let outputFilename = `${ticket}/${basename}`;

    console.log('tempDir', tempDir);
    console.log('tempFilename', tempFilename);
    console.log('outputFilename', outputFilename);

    if (!fs.existsSync(tempDir)) {
        fs.mkdirSync(tempDir);
    }

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
            // get metadata
            return gcs.bucket(file.bucket).file(file.name).getMetadata()
                .then(function(data) {
                    let metadata = data[0].metadata;
                    // download image to temp file
                    return Promise.all([metadata, gcs.bucket(file.bucket).file(file.name).download({destination: tempFilename})])
                });
        })
        .then(function(data) {
            console.log('downloaded!');
            let metadata = data[0];
            console.log(metadata);
            if (metadata.cas) {
                let cas = parseInt(metadata.cas);
                cas = (isNaN(cas) || cas < 0 || cas > 200) ? 50 : cas;
                let sac = Math.floor(100 * (100 / cas));
                // liquid rescale and find a single face in the photo
                let command1 = `mogrify -liquid-rescale ${cas}% ${tempFilename}`;
                let command2 = `mogrify -liquid-rescale ${sac}% ${tempFilename}`;
                return promiseExec(command1)
                    .then(function() {
                        return promiseExec(command2);
                    })
                    .then(function() {
                        return getSingleFace(tempFilename);
                    });
            } else {
                // find a single face in the photo
                return getSingleFace(tempFilename);
            }
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
            return gcs.bucket(config.TMP_BUCKET).upload(filename, {destination: outputFilename})
        })
        .then(function() {
            console.log('cleaning input image');
            // clean up
            fs.unlinkSync(tempFilename);
            return gcs.bucket(config.INPUT_BUCKET).file(file.name).delete()
        })
        .then(function() {
            console.log(`File ${outputFilename} processed`);
        })
        .catch(function(err) {
            console.log('processImage error:', err);
            return gcs.bucket(file.bucket).file(file.name).delete()
        });
};

exports.mergeImage = function(event, callback) {
    let message = event.data;
    let ticket = Buffer.from(message.data, 'base64').toString();
    console.log(ticket);
    let tempDir = `${config.TMP_DIR}/${ticket}-animate`;

    console.log('tempDir', tempDir);

    if (!fs.existsSync(tempDir)) {
        fs.mkdirSync(tempDir);
    }

    return Promise.resolve()
        .then(function() {
            console.log('listing files');
            // fetch the list of files in the tmp bucket
            return gcs.bucket(config.TMP_BUCKET).getFiles({prefix: ticket})
        })
        .then(function(data) {
            console.log('fetching files');
            let files = data[0];
            let bucket = gcs.bucket(config.TMP_BUCKET);
            let promises = [[]];
            if (files.length < 2) {
                throw new Error('Not enough files to animate!');
            }
            files.forEach(function(f) {
                let tmpFile = `${tempDir}/${path.parse(f.name).base}`;
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
            let outputFile = `${tempDir}/out.gif`;
            let command = 'convert -loop 0 -delay 10 ' + files.join(' ') + ' ' + outputFile;
            return Promise.all([outputFile, promiseExec(command)]);
        })
        .then(function(data) {
            let outputFile = data[0];
            let uploadFile = `${ticket}/out.gif`;
            console.log('animated as', outputFile);
            return Promise.all([uploadFile, gcs.bucket(config.OUTPUT_BUCKET).upload(outputFile, {destination: uploadFile})]);
        })
        .then(function(data) {
            console.log('making public...');
            let uploadFile = data[0];
            return gcs.bucket(config.OUTPUT_BUCKET).file(uploadFile).makePublic();
        })
        .then(function() {
            console.log('cleaning up...');
            return gcs.bucket(config.TMP_BUCKET).getFiles({prefix: ticket})
        })
        .then(function(data) {
            console.log('cleaning files');
            let files = data[0];
            let bucket = gcs.bucket(config.TMP_BUCKET);
            let promises = [[]];
            files.forEach(function(f) {
                promises.push(bucket.file(f.name).delete());
            });
            return Promise.all(promises);
        })
        .then(function() {
            console.log('animation complete');
            callback();
        })
        .catch(function(err) {
            console.log('mergeImage error:', err);
        });
};

function httpError(response, statusCode, errorMessage) {
    response.status(statusCode).end(JSON.stringify({"status": "error", "message": errorMessage}));
}

// https://stackoverflow.com/questions/20267939/nodejs-write-base64-image-file
function decodeBase64Image(dataString) {
    console.log('decoding image:', dataString.substring(0, 30));
    let matches = dataString.match(/^data:([A-Za-z-\+\/]+);base64,(.+)$/m);
    let response = {};
    if (!matches) {
        console.log('malformed content');
        return undefined;
    }
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
