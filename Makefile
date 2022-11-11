SHELL := /bin/bash -c
# stack-name
# lambda upload bucket (a priori)
# prefix (pre-defined account name/)
# buckets
# table name
# lambda layer
# all lambda function names?
# two buckets now: results, uploads

# This should be the same as Unique in CFN files.
UNIQUE := losalamosal
OFFLINE_STACK := $(UNIQUE)--bookfinder-offline
CFN_FILE := build-book-db.yml
REKOG_LAMBDA := rekog.js
SEARCH_LAMBDA := search.js

# Bucket must exist and have versioning enabled
LAMBDA_UPLOAD_BUCKET := $(UNIQUE)--lambda-uploads
LAMBDA_UPLOAD_STACK := $(UNIQUE)--lambda-upload
LAMBDA_UPLOAD_CFN := lambda-bucket.yml

OFFLINE_UPLOADS_BUCKET := $(UNIQUE)--bookfinder-offline-uploads
OFFLINE_RESULTS_BUCKET := $(UNIQUE)--bookfinder-offline-results

error:
	@echo "Please choose one of the following targets: create, update, delete"
	@echo "For more info see README.md in the GitHub repo"
	@exit 2

create:
	@if aws cloudformation describe-stacks --stack-name $(LAMBDA_UPLOAD_STACK) &> /dev/null; then \
		echo "Lambda upload stack already exists--did you mean to run make deploy?" ;\
		exit 2 ;\
	fi
# Create the bucket (version-enabled) to upload lambda functions to.
	@aws cloudformation deploy --stack-name $(LAMBDA_UPLOAD_STACK)                          \
		--template-file $(LAMBDA_UPLOAD_CFN)                                               \
		--parameter-overrides Unique=$(UNIQUE)  
	@if aws cloudformation describe-stacks --stack-name $(OFFLINE_STACK) &> /dev/null; then \
		echo "Offline processing stack already exists--did you mean to run make deploy?" ;\
		exit 2 ;\
	fi
# Create initial Zip file with all lambdas.
# USE RECURSIVE MAKE HERE????
	@cd lambda; npm install
	@echo "Initial lambdas: Zipping and uploading initial versions..."
	@cd lambda; zip -FS -r -q ../lambda.zip $(REKOG_LAMBDA) $(SEARCH_LAMBDA) node_modules
	@aws s3 cp lambda.zip s3://$(LAMBDA_UPLOAD_BUCKET)
	@set -e    ;\
	zip_version=$$(aws s3api list-object-versions                                 \
		--bucket $(LAMBDA_UPLOAD_BUCKET) --prefix lambda.zip                             \
		--query 'Versions[?IsLatest == `true`].VersionId | [0]'                   \
		--output text)                                                           ;\
	echo "Running aws cloudformation deploy with ZIP version $$zip_version..."   ;\
	aws cloudformation deploy --stack-name $(OFFLINE_STACK)                          \
		--template-file $(CFN_FILE)                                               \
		--parameter-overrides     \
			ZipVersionId=$$zip_version                          \
			ZipBucketName=$(LAMBDA_UPLOAD_BUCKET)           \
			Unique=$(UNIQUE)    \
		--capabilities CAPABILITY_NAMED_IAM


update: lambda.zip lambda/node_modules

delete:
	@if ! aws cloudformation describe-stacks --stack-name $(LAMBDA_UPLOAD_STACK) &> /dev/null; then \
		echo "Lambda upload stack does not exist--can not delete it!" ;\
		exit 2 ;\
	fi
	@aws s3api list-object-versions \
		--bucket $(LAMBDA_UPLOAD_BUCKET) \
		--output=json \
		--query='{Objects: Versions[].{Key:Key,VersionId:VersionId}}' > /tmp/files_to_delete
	@aws s3api delete-objects --bucket $(LAMBDA_UPLOAD_BUCKET) --delete file:///tmp/files_to_delete
	@aws cloudformation delete-stack --stack-name $(LAMBDA_UPLOAD_STACK)
	@rm /tmp/files_to_delete
	@rm lambda.zip
	@rm -rf lambda/node_modules



.PHONY: test
test:
	@set -e ;\
	if ! aws cloudformation describe-stacks --stack-name book-finder--cognito-auth &> /dev/null; then \
		echo "Cognito auth stack not created: create it via Makefile.cognito" ;\
		exit 1 ;\
	fi   ;\
	client_id=$$(aws cloudformation describe-stacks --stack-name book-finder--cognito-auth \
		--query 'Stacks[0].Outputs[?OutputKey == `UserPoolClientId`].OutputValue' \
		--output text)   ;\
	echo $$client_id    ;\
	pool_id=$$(aws cloudformation describe-stacks --stack-name book-finder--cognito-auth \
		--query 'Stacks[0].Outputs[?OutputKey == `UserPoolId`].OutputValue' \
		--output text)   ;\
	echo $$pool_id    ;\
