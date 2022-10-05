// TODO: Add descriptive header comment.
const path = require("path");
const { Image, createCanvas } = require("canvas");

const { S3Client, GetObjectCommand, PutObjectCommand } = require("@aws-sdk/client-s3");
const { RekognitionClient, DetectTextCommand } = require("@aws-sdk/client-rekognition");
const { DynamoDBClient, PutItemCommand } = require("@aws-sdk/client-dynamodb");

const dynoClient = new DynamoDBClient();
const s3client = new S3Client();
const rekClient = new RekognitionClient();

// Failsafe to stop potentially runaway lambda. We expect Rekognition to eventually
// return zero text found. If for some reason it doesn't (e.g. keeps finding one
// more word) then this will limit the total number of passes executed. If this
// condidtion is triggered it's considered an error: investigate and determine
// why Rekognition isn't returning zero at some point.
const MAX_PASSES = 15;

exports.handler = async (event, context) => {
  // The book-finder application uses S3 bucket and key conventions for
  // locations of uploaded images and other data produced by this offline
  // process (e.g. images, JSON files, etc.).
  //
  // Two buckets are created in the AWS account that is runnning the
  // book-finder infrastructure: an upload bucket and a processed bucket.

  // Upon registration, a pair of unique keys are created for the user
  // which result in psuedo-directories for that user:
  //
  // s3://upload-bucket-name/UUID
  // s3://upload-bucket-p/UUID
  //
  // The upload bucket has a trigger that will call this lambda function
  // when a new image is uploaded. This lambda runs AWS Rekognition on that
  // image to find text on the spines of the book. This lambda function
  // writes its output into the user's upload-bucket-p using different prefixes to
  // organize the output:
  //
  // s3://upload-bucket-p/UUID/debug
  // s3://upload-bucket-p/UUID/white
  // s3://upload-bucket-p/UUID/thumb
  // s3://upload-bucket-p/UUID/json
  //
  // debug: images that help in debugging the lambda function
  // white: images with previously found text "whited out" are used as
  //        input to subsequent passes of the text recognition code
  //        (see description of the saveWhiteoutImage function)
  // thumb  smaller version of the original input image
  // json   one JSON file for each text rekognition pass that contains
  //        the text found on that pass as well as other data (e.g. confidence
  //        level, bounding box, etc.)
  //
  // We use a convention similar to that used in the AWS S3 console interface.
  // S3 names are defined by the bucket and the key of the object:
  //
  // s3://bucket-name/object-key
  //
  // We break the object-key into two parts to help organize out data by user
  // and function: prefix/base. This emulates a Unix-style directory structure.
  //
  // s3://upload-bucket/UUID/base.png             - all uploads must be PNG files
  // s3://upload-bucket-p/UUID/debug/base-n.png   - one debug image for each pass
  // s3://upload-bucket-p/UUID/white/base-n.png   - one whiteout image for each pass
  // s3://upload-bucket-p/UUID/thumb/base.png     - one thumbnail for each upload
  // s3://upload-bucket-p/UUID/json/base.png      - one file of text found per upload
  //
  // We extract base.png and UUID from the S3 name passed to lambda:
  //
  // s3://upload-bucket/UUID/base.png
  //     |             |
  //     +-- bucket ---+----- key -------       - lambda functions receives this
  //
  // Given the upload bucket, UUID, and base, we can construct all the others as
  // shown above.

  console.log(JSON.stringify(event));

  // TODO: refactor all valuse to make sense (names vs. objects)
  const uploadBucket = event.Records[0].s3.bucket.name;
  const resultsBucket = uploadBucket.replace("originals", "results"); // FIXME: make this a BUCKET!
  const uploadKey = decodeURIComponent(event.Records[0].s3.object.key.replace(/\+/g, " "));
  const uploadImage = path.basename(uploadKey); // full image name with extension
  const uploadBase = path.basename(uploadKey, ".png"); // strip prefix and extension
  const uploadPrefix = path.dirname(uploadKey);
  const userUUID = uploadPrefix.split(path.sep)[1];
  console.log(`event.Records[0].s3.object.key: ${event.Records[0].s3.object.key}`);
  console.log(`userUUID: ${userUUID}`);
  console.log(`uploadBucket: ${uploadBucket}`);
  console.log(`resultsBucket: ${resultsBucket}`);
  console.log(`uploadKey: ${uploadKey}`);
  console.log(`uploadBase: ${uploadBase}`);
  console.log(`uploadImage: ${uploadImage}`);
  console.log(`uploadPrefix: ${uploadPrefix}`);

  let originalImage = await loadOriginalImage(uploadBucket, uploadKey); // actual image; not name of image
  console.log(`originalImage    w: ${originalImage.width}  h: ${originalImage.height}`);

  // This is the main loop. Rekognition will likely NOT find all the text in the image
  // in a single pass. So, we continue running passes through the loop until Rekognition
  // returns zero text found or we reach the MAX_PASSES safety limit.
  let allFound = { TextDetections: [] };
  let rekogKey = uploadKey; // original image for first pass, then whiteout images
  let rekogImage = originalImage;
  for (var i = 0; i < MAX_PASSES; i++) {
    var found = await rekogText(uploadBucket, rekogKey); // var so available after loop
    console.log(`rekogText: ${found.TextDetections.length} found on pass ${i}`);
    if (found.TextDetections.length == 0) break; // no more text to find
    allFound = mergeFound(allFound, found); // merge this pass results with previous passes
    // TODO: save only one annotated image after loop?
    await saveAnnotatedImage(rekogImage, uploadBucket, uploadBase, found, i); // for debugging
    // Write the whiteout image and return a copy for the next pass -- written image is for debugging
    [rekogKey, rekogImage] = await saveWhiteoutImage(
      rekogImage,
      uploadBucket,
      uploadBase,
      found,
      i
    );
  }

  if (i == MAX_PASSES && found.TextDetections.length != 0) {
    console.log(`main loop ended after ${MAX_PASSES} with text yet to be found`);
    console.log(`writing results for text found, but this condition should be considered an error`);
  }

  await saveThumbnailImage(originalImage, uploadBucket, uploadBase); // so client doesn't have to resize
  await writeAllFound(uploadBucket, uploadBase, allFound, userUUID, uploadImage); // JSON file of all detections

  return `findTextInBookImage finished: ${uploadBucket}/${uploadKey}`;
};

// --------------------------------------------------
// Find text in image
// Image (PNG file) is in S3 bucket
async function rekogText(bucket, key) {
  const params = {
    Image: {
      S3Object: {
        Bucket: bucket,
        Name: key
      }
    }
  };
  const command = new DetectTextCommand(params);

  try {
    let start = performance.now();
    const data = await rekClient.send(command);
    let et = performance.now() - start;
    console.log(`text detection took ${et / 1000} sec`);
    return data;
  } catch (error) {
    console.log(`rekogText failed: ${JSON.stringify(error)}`);
    throw new Error(JSON.stringify(error));
  }
}

// --------------------------------------------------
// Write JSON version of ALL text found in image
// Written data is result of merging data from all passes
// into the single object.
async function writeAllFound(bucket, basename, found, uuid, imageName) {
  // Make returned JSON smaller by reducing precision of the
  // X and Y values of the text's bounding polygon and deleting
  // all occurrences of WORDs found (client and server only need
  // LINEs).
  // https://stackoverflow.com/a/9340239/227441
  let start = performance.now();

  // FIXME: tie this modification to the comment on keeping LINEs (below)
  found.TextDetections.forEach((label) => {
    delete label.Geometry.BoundingBox;
    if (label.Type == "LINE") {
      delete label.Geometry;
    }
  });

  // Initially we thought the UI would only need LINEs. But, since the bounding
  // boxes on them are so "odd" we will probably keep LINEs in the output JSON.
  found.TextDetections = found.TextDetections.filter((t) => t.Type == "LINE");

  // FIXME: figure out where ParentId == undefined is coming from!?
  // TODO: write a simple test for this "bug"
  // For some unknown reason the following will fail with ParentId === undefined
  // on a LINE even though LINEs don't have a ParentId KV pair, Mystifying.
  reduced = JSON.stringify(found, function (key, val) {
    if (val !== undefined) return val.toFixed ? Number(val.toFixed(3)) : val;
  });

  let et = performance.now() - start;
  console.log(`writeAllFound: reducing precision and entries took ${et / 1000} sec`);

  // This extra step is needed to quote (e.g. \") all internal double quotes if we're
  // going to put this into DynamoDB. It's the client's responsibility to unquote
  // (e.g. parse) correctly. DynamoDB doesn't directly support JSON item types.
  const quoteReduced = JSON.stringify(reduced);

  const params = {
    Bucket: bucket,
    Key: `json/${basename}.json`,
    Body: quoteReduced
  };
  const command = new PutObjectCommand(params);

  // TODO: Once we have a command, can all S3 puts (ala below) be abstracted
  //        out into a single function?
  try {
    let start = performance.now();
    const data = await s3client.send(command);
    let et = performance.now() - start;
    console.log(`writeAllFound: S3 write took ${et / 1000} sec`);
    //return;
  } catch (err) {
    console.log(`writeAllFound failed: ${JSON.stringify(err)}`);
    throw new Error(JSON.stringify(err));
  }

  const putParams = {
    TableName: process.env.DB_TABLE_NAME,
    Item: {
      Id: { S: uuid },
      Image: { S: imageName },
      RekogResults: { S: quoteReduced }
    }
  };

  const putItemCommand = new PutItemCommand(putParams);

  let ret = {
    isBase64Encoded: false,
    statusCode: 200,
    headers: { "Access-Control-Allow-Origin": "*" },
    body: process.env.DB_TABLE_NAME
  };

  try {
    const data = await dynoClient.send(putItemCommand);
    ret.body = data;
    return ret;
  } catch (error) {
    console.log(`putItemCommand failed: ${JSON.stringify(error)}`);
    throw new Error(error);
  }
}

// --------------------------------------------------
// Merge found text from current pass (additions) into
// cumulative object (all) containing text found in previous passes.
function mergeFound(all, additions) {
  all.TextDetections = all.TextDetections.concat(additions.TextDetections);
  return all;
}

// --------------------------------------------------
// Read original source image from S3 and make a node-canvas
// Image object out of it.
async function loadOriginalImage(bucket, key) {
  const params = {
    Bucket: bucket,
    Key: key
  };
  const command = new GetObjectCommand(params);

  const streamToBuffer = (stream) => {
    return new Promise((resolve, reject) => {
      const chunks = [];
      stream.on("data", (chunk) => chunks.push(chunk));
      stream.on("error", reject);
      stream.on("end", () => resolve(Buffer.concat(chunks)));
    });
  };

  let original = new Image();
  try {
    let start = performance.now();
    const data = await s3client.send(command);
    const body = await streamToBuffer(data.Body);
    let et = performance.now() - start;
    console.log(`loadOriginalImage ${et / 1000} sec`);
    original.src = body;
    return original;
  } catch (error) {
    console.log(`loadOriginalImage failed: ${JSON.stringify(error)}`);
    throw new Error(JSON.stringify(error));
  }
}

// --------------------------------------------------
// Save a reduced size version of the original image.
async function saveThumbnailImage(image, bucket, basename) {
  const w = image.width;
  const h = image.height;
  const canvas = createCanvas(w / 4, h / 4);
  const ctx = canvas.getContext("2d");
  let start = performance.now();
  ctx.drawImage(image, 0, 0, w / 4, h / 4);
  let et = performance.now() - start;
  console.log(`saveThumbnailImage: drawImage took ${et / 1000} sec`);

  start = performance.now();
  const buffer = canvas.toBuffer("image/png", {
    compressionLevel: 1,
    filters: canvas.PNG_ALL_FILTERS
  });
  et = performance.now() - start;
  console.log(`saveThumbnailImage: toBuffer took ${et / 1000} sec`);
  const params = {
    Bucket: bucket,
    Key: `thumbs/${basename}.png`,
    Body: buffer
  };
  const command = new PutObjectCommand(params);

  try {
    let start = performance.now();
    const data = await s3client.send(command);
    let et = performance.now() - start;
    console.log(`put S3 thumbnail image took ${et / 1000} sec`);
    return;
  } catch (err) {
    console.log(`saveThumbnailImage failed: ${JSON.stringify(error)}`);
    throw new Error(JSON.stringify(err));
  }
}

// --------------------------------------------------
// Save a copy of the original images but, draw boxes and paths that show
// text found on this pass.
async function saveAnnotatedImage(image, bucket, basename, found, pass) {
  const w = image.width;
  const h = image.height;
  const canvas = createCanvas(w, h);
  const ctx = canvas.getContext("2d");
  let start = performance.now();
  ctx.drawImage(image, 0, 0);
  let et = performance.now() - start;
  console.log(`saveAnnotatedImage: drawImage took ${et / 1000} sec`);

  // FIXME: how do unquoted vals (e.g. poly.Y) work on a JSON object?
  found.TextDetections.forEach((label) => {
    if (label.Type == "LINE") {
      // Draw a semi-transparent box over all LINEs found.
      ctx.fillStyle = "rgba(255, 255, 255, 0.62)";
      ctx.beginPath();
      let first = true;
      label.Geometry.Polygon.forEach((poly) => {
        if (first) {
          ctx.moveTo(w * poly.X, h * poly.Y);
          first = false;
        } else {
          ctx.lineTo(w * poly.X, h * poly.Y);
        }
      });
      ctx.fill();
    } else {
      // Draw a red line around all WORDs found.
      ctx.lineWidth = 5;
      ctx.strokeStyle = "rgba(227, 11, 11, 0.92)";
      ctx.beginPath();
      let first = true;
      label.Geometry.Polygon.forEach((poly) => {
        if (first) {
          ctx.moveTo(w * poly.X, h * poly.Y);
          first = false;
        } else {
          ctx.lineTo(w * poly.X, h * poly.Y);
        }
      });
      ctx.closePath();
      ctx.stroke();
    }
  });

  start = performance.now();
  const buffer = canvas.toBuffer("image/png", {
    compressionLevel: 1,
    filters: canvas.PNG_ALL_FILTERS
  });
  et = performance.now() - start;
  console.log(`saveAnnotatedImage: toBuffer took ${et / 1000} sec`);

  const annotationKey = basename + `-${pass}.png`;
  const params = {
    Bucket: bucket,
    Key: `debug/${basename}-${pass}.png`,
    Body: buffer
  };
  const command = new PutObjectCommand(params);

  try {
    let start = performance.now();
    const data = await s3client.send(command);
    let et = performance.now() - start;
    console.log(`saveAnnotatedImage : S3 write took ${et / 1000} sec`);
    return;
  } catch (err) {
    console.log(`saveAnnotatedImage failed: ${JSON.stringify(error)}`);
    throw new Error(JSON.stringify(err));
  }
}

// --------------------------------------------------
// Save image for next pass at text reognition. The input
// image is the source image of the previous pass. Here we
// draw white boxes over the text that was detected and
// return that as a new source image for the next pass
// (so Rekognition doesn't detect the same text again).
// We also write the image to S3 for debugging purposes.
async function saveWhiteoutImage(image, bucket, basename, found, pass) {
  const w = image.width;
  const h = image.height;
  const canvas = createCanvas(w, h);
  const ctx = canvas.getContext("2d");
  let start = performance.now();
  ctx.drawImage(image, 0, 0);
  let et = performance.now() - start;
  console.log(`saveWhiteoutImage: drawImage took ${et / 1000} sec`);

  found.TextDetections.forEach((label) => {
    // Draw an opaque white box over all WORDs found.
    if (label.Type == "WORD") {
      ctx.fillStyle = "rgba(255, 255, 255, 1.0)";
      ctx.beginPath();
      let first = true;
      label.Geometry.Polygon.forEach((poly) => {
        if (first) {
          ctx.moveTo(w * poly.X, h * poly.Y);
          first = false;
        } else {
          ctx.lineTo(w * poly.X, h * poly.Y);
        }
      });
      ctx.fill();
    }
  });

  start = performance.now();
  const buffer = canvas.toBuffer("image/png", {
    compressionLevel: 1,
    filters: canvas.PNG_ALL_FILTERS
  });
  et = performance.now() - start;
  console.log(`saveWhiteoutImage: toBuffer took ${et / 1000} sec`);

  const params = {
    Bucket: bucket,
    Key: `white/${basename}-${pass}.png`,
    Body: buffer
  };
  console.log(`params.Key: ${params.Key}`);
  const command = new PutObjectCommand(params);

  const nextPassImage = new Image();
  nextPassImage.src = buffer;

  try {
    let start = performance.now();
    const data = await s3client.send(command);
    let et = performance.now() - start;
    console.log(`saveWhiteoutImage: S3 write took ${et / 1000} sec`);
    return [params.Key, nextPassImage];
  } catch (err) {
    console.log(`saveWhiteoutImage failed: ${JSON.stringify(error)}`);
    throw new Error(JSON.stringify(err));
  }
}
