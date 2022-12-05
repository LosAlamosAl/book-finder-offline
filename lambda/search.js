// If we're using Node 18.x we don't need to include JS SDK
// TODO: Add descriptive header comment.
const { Image, createCanvas } = require("canvas");

const { S3Client, GetObjectCommand, PutObjectCommand } = require("@aws-sdk/client-s3");
const {
  DynamoDBClient,
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
  console.log(JSON.stringify(event));

  const lambdaInput = JSON.parse(event.body);
  console.log(lambdaInput);

  const resultsBucket = process.env.RESULTS_BUCKET_NAME;
  const uploadsBucket = process.env.UPLOADS_BUCKET_NAME;
  const tableName = process.env.DB_TABLE_NAME;

  const nowString = Date.now();

  const userUUID = lambdaInput.UUID;
  const uploadPrefix = `${uploadsBucket}/${userUUID}`;
  const resultsPrefix = `${resultsBucket}/${userUUID}/${nowString}`;
  const searchTerms = lambdaInput.keywords;
  console.log(searchTerms);

  console.log(`userUUID: ${userUUID}`);
  console.log(`uploadBucket: ${uploadsBucket}`);
  console.log(`resultsBucket: ${resultsBucket}`);
  console.log(`resultsPrefix: ${resultsPrefix}`);
  console.log(`tableName: ${tableName}`);

  // Get all the text found, in all images, for this UUID.
  const allTextFound = await getTextFoundFromDB(userUUID, tableName);
  console.log(allTextFound);
  const textFoundByImage = [];
  for (i of allTextFound.Items) {
    textFoundByImage.push({ image: i.Image.S, text: JSON.parse(i.RekogResults.S) });
  }
  console.log(textFoundByImage);

  // For each image, search it for matches with the search terms.
  let searchSummary = [];
  for (i of textFoundByImage) {
    let searchResultsForImage = searchImage(i, searchTerms);
    let imageSummary = updateSearchSummary(searchResultsForImage);
    console.log(imageSummary);
    searchSummary.push(imageSummary);
    console.log(searchResultsForImage);
    writeSearchResultsJSON(searchResultsForImage, resultsPrefix);
    writeSearchResultsImage(searchResultsForImage, resultsPrefix, uploadPrefix);
  }

  console.log(elapsedTimers);
  let ret = {
    isBase64Encoded: false,
    statusCode: 200,
    headers: { "Access-Control-Allow-Origin": "*" },
    body: JSON.stringify(searchSummary)
  };

  return ret;
};

// Return
// {image: "name", results: [{keyword: "term", DetectedText: [...]}
function searchImage(allText, terms) {
  let ret = {
    image: allText.image,
    results: []
  };

  for (t of terms) {
    let hits = {
      keyword: t,
      TextDetections: []
    };
    for (i of allText.text.TextDetections) {
      if (i.DetectedText.toLowerCase().includes(t.toLowerCase())) {
        hits.TextDetections.push(i);
      }
    }
    ret.results.push(hits);
  }

  return ret;
}

function updateSearchSummary(imageResults) {
  // by image
  let imageSummary = {
    image: imageResults.image,
    summary: []
  };
  for (k of imageResults.results) {
    // by keyword
    let keywordSummary = {
      keyword: k.keyword,
      searchHits: []
    };
    for (t of k.TextDetections) {
      // by LINE or WORD
      keywordSummary.searchHits.push({ text: t.DetectedText, type: t.Type });
    }
    imageSummary.summary.push(keywordSummary);
  }
  return imageSummary;
}

function writeSearchResultsJSON(results, outPrefix) {}

function writeSearchResultsImage(results, outPrefix, inPrefix) {}

// --------------------------------------------------

// --------------------------------------------------
// Add an entry in the global timer structure.
function setElapsedTime(key, et) {
  if (!(key in elapsedTimers)) elapsedTimers[key] = [];
  elapsedTimers[key].push(et / 1000);
}

// --------------------------------------------------
// Query the DynamoDB database to get all text found (by Rekognition)
// in all images for a given id (userUUID).
async function getTextFoundFromDB(id, table) {
  const queryParams = {
    TableName: table,
    KeyConditionExpression: "Id = :id",
    ExpressionAttributeValues: {
      ":id": { S: id }
    }
  };

  const queryCommand = new QueryCommand(queryParams);

  try {
    const start = performance.now();
    const data = await dynoClient.send(queryCommand);
    setElapsedTime("getTextFoundFromDB: queryCommand", performance.now() - start);
    return data;
  } catch (error) {
    console.log(`queryCommand failed: ${JSON.stringify(error)}`);
    throw new Error(error);
  }
}
