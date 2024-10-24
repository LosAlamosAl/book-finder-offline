<!--
Local Variables:
fill-column: 90
indent-tabs-mode: nil
End:
-->

ALSO CONSIDER USING TAGS TO MAKE RESOURCE EXPLORER USEFUL:
[`cloudformation deploy`](https://stackoverflow.com/a/66692293/227441)

## Book Finder: Offline Processing

- Requirements
  - AWS account
    - Permissions required to build
  - Tools
  - Lambda layer for `node-canvas`
    - Limitations and performance problems.
- Description of Application
  - Limitations and pointer to @mcpherson's work
- Building
  - CFN structure
    - What resources are built
    - Why multiple CFN files?
  - The Makefile
    - Naming conventions
    - Likelyhood of brittleness
- Running
  - Outputs
  - Commands
    - `curl`
    - Various `aws` commands
    - `make`, `bash`
    - `jq`
      - versus `--query`
- Warnings and Caveats
  - S3 trigger
  - canvas-nodejs performance
  - Seperate bucket for upload trigger, but still be careful
  - Lambda bucket versioning (why?)

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
precision of the X and Y elements that delimit text bounding polygon) means small amount
of data. Could just load it into lambda as part of `node_modules` or put it in a lambda
layer. Found a post on the web where a guy uses lambda layers to store small hash tables
for rapid search. This is the same approach.

### Force a deployment

CFN will not do another deployomet is one already exists. [This solution](https://stackoverflow.com/a/60558544) uses the CLI to force a new deploy. I don't **think** it results in drift.

```sh
aws apigateway create-deployment --rest-api-id REST_API_ID \
  --stage-name dev --description 'Deployed from CLI; drift warning'
```

Remember to **delete** `lambda.zip` when you delete the stack.

Setting up a pull request for Boo's main repository. First, fork his repository and clone it to my machine. Then:

```sh
git checkout -b new-branch-name
diff -Naru server/lambda/rekog.js ~/GitHub/book-finder-offline/lambda/rekog.js > ~/tmp/boo.patch
patch server/lambda/rekog.js < ~/tmp/boo.patch
git add -A
git commit -m "Message"
git push --set-upstream origin new-branch-name
```

Finally, go to GitHub and submit the PR.

One reason **not** to use the `package` method of lambda upload: it requires an update to
the stack. If you do it my way, with zip version passed in, you can skip CFN update and
just set the new lambda code on the lambda resource (using `aws lambda
update-function-code`).

Lame duplication of S3 read/write functions and drawing code. Could move in to module.

Remember UUID and trailing slash on initial image upload:

```sh
aws s3 cp file.png s3://bucket/some-user-id/
```

Add a flag for true substring search, or only word search.

Describe why the node-canvas lambda layer is needed. Also, why it is so slow.

Possible errors:

- lambda timeout on images with a lot of text

Explain tilted bug.

What's left that must be deleted manually after a `make delete`?

- API Gateway welcome log
- API Gateway execution logs
- Probably a bunch of IAM stuff

Figure out custom domain again.

### License

This software is licensed under the GNU General Public License v3.0 or later.

See [COPYING](https://github.com/LosAlamosAl/book-finder-offline/blob/main/COPYING) to see the full text of the license.

### Building the Application for the First Time

You'll need to install (or deploy) a lambda layer from the Serverless Application
Repository before building the application. This layer will be used by the lambda
functions for image processing functionality. This only needs to be done once per account
that you want to run this application from. To deploy:

1. From the AWS console, visit the Serverless Application Repository page.
1. Click on "Available Applications".
1. Enter `canvas-nodejs` in the search box.
1. A box with the title of `lambda-layer-canvas-nodejs` will be shown--click on
   `lambda-layer-canvas-nodejs`.
1. On the "Review, configure and deploy" page, click on the orange deploy button at the
   bottom right. This will run Cloudformation to create a stack
   (serverlessrepo-lambda-layer-canvas-nodejs) with a single resource, the lambda layer
   (`canvas-nodejs`).
1. Visit the Lambda page from the console, click on layers, click on `canvas-nodejs`, and
   copy its ARN (shown as Version ARN). It'll look something like
   `arn:aws:lambda:us-west-2:XXXXXXXXXXX:layer:canvas-nodejs:5` where `XXXXXXXXXXX` will
   be your account number.
1. Paste the copied ARN into the `build-book-db.yml`, replacing the placeholder string
   `LAMBDA-LAYER-ARN-PLACEHOLDER` <u>**in both locations in the file**</u>. Save your
   changes.

Now that the lambda layer has been installed, you can contine with the actual building of
the application. To build the application:

1. Edit the `Makefile` in the top level directory (**not** the `Makefile` in the `lambda`
   directory), choose a unique prefix string for _your version of the application_, and
   replace the `UNIQUE-STRING-PLACEHOLDER` with it. This is required because all S3 bucket
   names must be globally unique. Save your changes.
1. At the command line (VSCode) or in a shell type `make create`. The `create` parameter
   is only used for the initial build. Subsequent updates to the build will use `make
update`. See below for update instructions.

The `Makefile` creates a number of resources in your account as a result of running
Cloudformation twice, creating two stacks: `YOUR-UNIQUE--bookfinder-offline` and
`YOUR-UNIQUE--lambda-upload`. Most of the resources (API Gateway, DynamoDB, Lambda, etc.)
are in the `YOUR-UNIQUE--bookfinder-offline` stack. The `YOUR-UNIQUE--lambda-upload`
creates a versioned bucket that stores the lambda code. See the [BLOG POST]() for full
details.

### Using the Application

```sh
> aws cloudformation describe-stacks  \
    --stack-name YOUR-UNIQUE--bookfinder-offline  \
    --query 'Stacks[].Outputs[]' --output text
BookFinderGatewayInvokeURL      https://xxxxxxxx.execute-api.us-west-2.amazonaws.com/dev
```

where `xxxxxxxxxxx` is the API ID.

Will display the API Gateway endpoint. This will be used when we search our database for
images that match a specified string.

```sh
> aws s3 ls
2023-08-04 21:58:28 YOUR-UNIQUE--bookfinder-results
2023-08-04 21:59:01 YOUR-UNIQUE--bookfinder-uploads
2023-08-04 21:57:16 YOUR-UNIQUE--lambda-uploads
```

```sh
> aws s3 cp ./images/office0.png s3://YOUR-UNIQUE--bookfinder-uploads/arbitrary-uuid/
upload: images/office0.png to s3://YOUR-UNIQUE--bookfinder-uploads/arbitrary-uuid/office0.png
```

Make sure to add the trailing `/` on the `aws s3 cp` command.

Commands get a little long so there's a script. The `results` directory is ignored by git,
so feel free to stuff you results there.

```bash
> bash
$ mkdir -p ./results/arbitrary-uuid/json/ &&  \
    aws s3 cp s3://losalamosal--bookfinder-results/arbitrary-uuid/json/office0.json ./results/arbitrary-uuid/json/
$ mkdir -p ./results/arbitrary-uuid/thumb/ && aws s3 cp s3://losalamosal--bookfinder-results/arbitrary-uuid/thumb/office0.json ./results/arbitrary-uuid/thumb/
$ mkdir -p ./results/arbitrary-uuid/thumb/ && aws s3 cp s3://losalamosal--bookfinder-results/arbitrary-uuid/thumb/office0.png ./results/arbitrary-uuid/thumb/
$ mkdir -p ./results/arbitrary-uuid/white/ && aws s3 cp s3://losalamosal--bookfinder-results/arbitrary-uuid/white/office0-0.png ./results/arbitrary-uuid/white/
$ mkdir -p ./results/arbitrary-uuid/white/ && aws s3 cp s3://losalamosal--bookfinder-results/arbitrary-uuid/white/office0-1.png ./results/arbitrary-uuid/white/
```

### Deleting Application Resources

Finally, you can delete the lambda layer's stack and the layer itself (which is not
deleted automatically when the stack is deleted--it's `RETAIN`ed):

1. Visit the Cloudformation page from the console.
1. Delete the stack.
1. Visit the Lambda page from the console, click on layers, click on `canvas-nodejs`, and
   delete the layer.

At this point all resources created by this application will have been deleted.

I developed this code at age 67.

### Bugs I Need to Fix

- Only PNG images?
- `includeLines` switch not handled in search?
- Last results image hits not saved.
- Use Marlon's rendering for hits image?
- Add full S3 URL for results image and json results to search output.
- Don't return empty results (or image) if search fails on image.
- Each search writes data and images to S3--use caution.

![image](./results/arbitrary-uuid/1691192160995/office0.png)
