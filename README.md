## Book Finder: Offline Processing

`cat results/IMG_1241.json| jq '.TextDetections[].DetectedText'`
`cat results/IMG_1241.json| jq '. | fromjson'`

### S3 Requirements

#### Lambda Upload Bucket

This section describes how we use a Makefile and a version-enabled S3 bucket to
handle lambda ZIP uploads.

#### Image Processing Bucket

We need a bucket to store the uploaded images and the processed results.

```
s3-image-processing-bucket
  /originals      - upload images here; after processing they are noved to processed
  /processed      - images that have been operated on are move from originals to here
  /thumbs         - one thumbnail for each processed image;
                    should be available via HTTP to client application
  /json           - one JSON file of text matches for each processed image;
                  - server will read these to perform search;
                  - may possibly coalesce into one file with "shelf" reference
  /debug          - offline process may store intermediate iamges here;
                  - these would be the masked images or images showing matched text
  /passes         - input images for each rekognition pass; text that has been
                    previously found is covered with a white polygon so that it
                    isn't detected in subsequent passes.
```

File name format:

- `s3-image-processing-bucket/`
  - `/originals/file.png`: might want to put a "shelf" number in there somewhere
  - `/processed/file.png`: same as originals
  - `thumbs/file-thumb.png`
  - `/json/file.json`
  - `/debug/file-mode-n.png`: where mode can be "outline" or "masked"; n is the sequence of the intermediate image

### Data Storage

The records looks like (less than 400 byts per book, and could reduce that--don't need
all that precision in `X` and `Y`):

```json
{
  "TextDetections": [
    {
      "DetectedText": "Almost Vegetarian",
      "Type": "LINE",
      "Geometry": {
        "Polygon": [
          { "X": 0.2913122773170471, "Y": 0.45773550868034363 },
          { "X": 0.3072223961353302, "Y": 0.5984686017036438 },
          { "X": 0.2840229868888855, "Y": 0.6010913252830505 },
          { "X": 0.2681128680706024, "Y": 0.46035823225975037 }
        ]
      }
    }
  ]
}
```

Need a tool to merge multiple JSON files.

### Database Alternatives

DynamoDB: No unique key. Text substring search requires a scan. Will be slow.

Aurora Serverles: SQL. Can do substring search. Not really serverless--minimum monthly charge
of around $40 to keep server active.

DocumentDB: MongoDB clone. Would be good, but again not serverless. Minimum charge for server.

CloudSearch: Can index everything and do Google-type searches. Close enough searchs, etc.
Index can be updated using a lambda for new data. No free plan. Costs.

EFS: This is cheap and should work well, but must deal with VPC and getting lambda into same
VPC as EFS. Still may be a server charge.

Raw JSON data: This is the best approach. 300 books (300 \* 400 = 120KB, less if we limit
precision of the X and Y elements that delimit text bounding polygon)
means small amount of data. Could just
load it into lambda as part of `node_modules` or put it in a lambda layer. Found a post
on the web where a guy uses lambda layers to store small hash tables for rapid search.
This is the same approach.

### Force a deployment

CFN will not do another deployomet is one already exists. [This solution](https://stackoverflow.com/a/60558544) uses the CLI to force a new deploy. I don't **think** it results in drift.

```sh
aws apigateway create-deployment --rest-api-id REST_API_ID \
  --stage-name dev --description 'Deployed from CLI; drift warning'
```

Remember to **delete** `lambda.zip` when you delete the stack.
