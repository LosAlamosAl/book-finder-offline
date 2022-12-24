// If we're using Node 18.x we don't need to include JS SDK
// TODO: Add descriptive header comment.
const { Image, createCanvas } = require("canvas");

const { S3Client, GetObjectCommand, PutObjectCommand } = require("@aws-sdk/client-s3");
const {
  DynamoDBClient,
  GetItemCommand,
  QueryCommand,
  ConsumedCapacityFilterSensitiveLog
} = require("@aws-sdk/client-dynamodb");
const { SummaryFilterSensitiveLog } = require("@aws-sdk/client-rekognition");

const dynoClient = new DynamoDBClient();
const s3client = new S3Client();

// Quick and dirty global to collect elapsed run times. Used with setElapsedTime().
// Could be more general class, but it's quick and dirty.
const elapsedTimers = {};

exports.handler = async (event, context) => {
  const start = performance.now();
  console.log(JSON.stringify(event));

  const lambdaInput = JSON.parse(event.body);
  console.log(lambdaInput);

  const resultsBucket = process.env.RESULTS_BUCKET_NAME;
  const uploadsBucket = process.env.UPLOADS_BUCKET_NAME;
  const tableName = process.env.DB_TABLE_NAME;

  // Unique string identifies wach individual call to search.
  const nowString = Date.now();

  const userUUID = lambdaInput.UUID;
  const uploadsPrefix = `${userUUID}`;
  const resultsPrefix = `${userUUID}/${nowString}`;
  const searchTerms = lambdaInput.keywords;
  console.log(searchTerms);

  console.log(`userUUID: ${userUUID}`);
  console.log(`uploadsBucket: ${uploadsBucket}`);
  console.log(`uploadsPrefix" ${uploadsPrefix}`);
  console.log(`resultsBucket: ${resultsBucket}`);
  console.log(`resultsPrefix: ${resultsPrefix}`);
  console.log(`tableName: ${tableName}`);

  // Query the database to get all images associatated with given UUID.
  // These images will be used as second key on subsequent requests
  // to the database for found text for that UUID and image.
  const allImageKeys = await getAllImageKeys(userUUID, tableName);

  // Simplified summary of search results (searchSummary) returned to
  // caller of lambda. Full search results (searchDetail), including
  // bounding polygons, are written to a JSON file in S3.
  let searchSummary = [];
  let searchDetail = [];

  // Main loop
  for (imgKey of allImageKeys) {
    let textFoundForImage = await getTextFoundForImage(imgKey, userUUID, tableName);
    console.log("textFoundForImage:");
    console.log(textFoundForImage);
    let searchResultsForImage = searchImage(textFoundForImage, searchTerms);
    console.log("searchResultsForImage:");
    console.log(searchResultsForImage);
    let imageSummary = updateSearchSummary(searchResultsForImage);
    console.log("imageSummary:");
    console.log(imageSummary);
    searchSummary.push({ image: imgKey, results: imageSummary });
    searchDetail.push({ image: imgKey, results: searchResultsForImage });
    console.log("searchSummary:");
    console.log(searchSummary);
    console.log("searchDetail:");
    console.log(searchDetail);
    await writeSearchResultsImage(
      imgKey,
      searchResultsForImage,
      resultsBucket,
      resultsPrefix,
      uploadsBucket,
      uploadsPrefix
    );
  }

  await writeSearchResultsJSON(searchDetail, resultsBucket, resultsPrefix);

  setElapsedTime("The whole enchilada", performance.now() - start);
  console.log(elapsedTimers);

  searchSummary.push({ "execution times": elapsedTimers });

  let ret = {
    isBase64Encoded: false,
    statusCode: 200,
    headers: { "Access-Control-Allow-Origin": "*" },
    body: JSON.stringify(searchSummary)
  };

  return ret;
};

// --------------------------------------------------
// Return:
// [{keyword: "term", DetectedText: [...]]
function searchImage(allText, terms) {
  const start = performance.now();
  let ret = [];

  for (t of terms) {
    let hits = {
      keyword: t,
      TextDetections: []
    };
    for (i of allText.TextDetections) {
      if (i.DetectedText.toLowerCase().includes(t.toLowerCase())) {
        hits.TextDetections.push(i);
      }
    }
    ret.push(hits);
  }
  setElapsedTime("searchImage", performance.now() - start);
  return ret;
}

// --------------------------------------------------
// Summary results to return from lambda. Remove things
// that won't be useful in that context (e.g. Geometry).
function updateSearchSummary(imageResults) {
  const start = performance.now();
  // by image
  let imageSummary = [];

  for (k of imageResults) {
    // by keyword
    let keywordSummary = {
      keyword: k.keyword,
      searchHits: []
    };
    for (t of k.TextDetections) {
      // by LINE or WORD
      keywordSummary.searchHits.push({ text: t.DetectedText, type: t.Type });
    }
    imageSummary.push(keywordSummary);
  }
  setElapsedTime("updateSearchSummary", performance.now() - start);
  return imageSummary;
}

// --------------------------------------------------
// We already return them from this lambda, but let's
// save them to a file in S3 just in case (includes
// Geometry, etc. which we don't return from this lambda).
async function writeSearchResultsJSON(found, bucket, prefix) {
  let start = performance.now();

  const params = {
    Bucket: bucket,
    Key: `${prefix}/hits.json`,
    Body: JSON.stringify(found)
  };
  const command = new PutObjectCommand(params);

  try {
    const data = await s3client.send(command);
    setElapsedTime("writeSearchResultsJSON", performance.now() - start);
  } catch (err) {
    console.log(`writeSearchResultsJSON failed: ${JSON.stringify(err)}`);
    throw new Error(JSON.stringify(err));
  }
}

// --------------------------------------------------
// Save an image showing the keywords found in that image.
async function writeSearchResultsImage(imageName, found, outBucket, outPrefix, inBucket, inPrefix) {
  let image = await loadOriginalImage(inBucket, inPrefix, imageName);
  console.log(`originalImage    w: ${image.width}  h: ${image.height}`);

  const w = image.width;
  const h = image.height;
  const canvas = createCanvas(w, h);
  const ctx = canvas.getContext("2d");
  let start = performance.now();
  ctx.drawImage(image, 0, 0);
  setElapsedTime("writeSearcResultsImage: drawImage", performance.now() - start);

  // FIXME: This deeply nested loop is ugly. Try to simplify.
  for (hit of found) {
    // Not drawing LINEs--Rekognition results buggy. If they get it
    // fixed, add the code back in (from rekog.js).
    hit.TextDetections.forEach((label) => {
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
    });
  }

  start = performance.now();
  const buffer = canvas.toBuffer("image/png", {
    compressionLevel: 1,
    filters: canvas.PNG_ALL_FILTERS
  });
  setElapsedTime("writeSearchResultsImage: toBuffer", performance.now() - start);

  const params = {
    Bucket: outBucket,
    Key: `${outPrefix}/${imageName}`,
    Body: buffer
  };
  const command = new PutObjectCommand(params);

  try {
    let start = performance.now();
    const data = await s3client.send(command);
    setElapsedTime("writeSearchResultsImage: S3 write", performance.now() - start);
    return;
  } catch (err) {
    console.log(`writeSearchResultsImage failed: ${JSON.stringify(err)}`);
    throw new Error(JSON.stringify(err));
  }
}

// --------------------------------------------------

// --------------------------------------------------
// Add an entry in the global timer structure.
function setElapsedTime(key, et) {
  if (!(key in elapsedTimers)) elapsedTimers[key] = [];
  elapsedTimers[key].push(et / 1000);
}

// --------------------------------------------------
// Query the DynamoDB database to get all the image names (to be
// used as keys) for a given id (userUUID).
// Returns an array of strings which are the image names.
async function getAllImageKeys(id, table) {
  const queryParams = {
    TableName: table,
    KeyConditionExpression: "Id = :id",
    ExpressionAttributeValues: {
      ":id": { S: id }
    },
    ProjectionExpression: "Image"
  };

  const queryCommand = new QueryCommand(queryParams);

  try {
    const start = performance.now();
    const data = await dynoClient.send(queryCommand);
    let res = [];
    for (i of data.Items) {
      res.push(i.Image.S);
    }
    setElapsedTime("getAllImageKeys: queryCommand", performance.now() - start);
    return res;
  } catch (error) {
    console.log(`getAllImageKeys: queryCommand failed: ${JSON.stringify(error)}`);
    throw new Error(error);
  }
}

// --------------------------------------------------
// Query the DynamoDB database to get all text found (by Rekognition)
// in a single image for a given id (userUUID).
async function getTextFoundForImage(image, id, table) {
  const getParams = {
    TableName: table,
    Key: {
      Id: { S: id },
      Image: { S: image }
    }
  };

  const getItemCommand = new GetItemCommand(getParams);

  try {
    const start = performance.now();
    const data = await dynoClient.send(getItemCommand);
    setElapsedTime("getTextFoundForImage: getItemCommand", performance.now() - start);
    return JSON.parse(data.Item.RekogResults.S);
  } catch (error) {
    console.log(`getTextFoundForImage: getItemCommand failed: ${JSON.stringify(error)}`);
    throw new Error(error);
  }
}

// --------------------------------------------------
// Read original source image from S3 and make a node-canvas
// Image object out of it.
async function loadOriginalImage(bucket, prefix, key) {
  let start = performance.now();
  console.log(`loadOriginalImage loading: ${bucket}/${prefix}/${key}`);
  const params = {
    Bucket: bucket,
    Key: `${prefix}/${key}`
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
    const data = await s3client.send(command);
    const body = await streamToBuffer(data.Body);
    setElapsedTime("loadOriginalImage", performance.now() - start);

    original.src = body;
    return original;
  } catch (error) {
    console.log(`loadOriginalImage failed: ${JSON.stringify(error)}`);
    throw new Error(error);
  }
}
