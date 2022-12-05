# This Makefile is probably overly complex and error prone. But, it
# does make developer life easier.
# FIXME: Investigate SAM CLI or scripting to replace use of make.
SHELL := /bin/bash
.SHELLFLAGS := -c

# This should be the same as Unique in CFN files
# FIXME: the above requirement is error prone--don't do defaults
UNIQUE := losalamosal
OFFLINE_STACK := $(UNIQUE)--bookfinder-offline
CFN_FILE := build-book-db.yml

# Bucket must exist and have versioning enabled
export LAMBDA_UPLOAD_BUCKET := $(UNIQUE)--lambda-uploads
LAMBDA_UPLOAD_STACK := $(UNIQUE)--lambda-upload
LAMBDA_UPLOAD_CFN := lambda-bucket.yml

OFFLINE_UPLOADS_BUCKET := $(UNIQUE)--bookfinder-offline-uploads
OFFLINE_RESULTS_BUCKET := $(UNIQUE)--bookfinder-offline-results

# --- Default target will be un when no target specified. -----------------------------------
.PHONY: error
error:
	@echo "Please choose one of the following targets: create, update, delete"
	@echo "For more info see README.md in the GitHub repo"
	@exit 2

# --- Create everything from scratch -- must be called first --------------------------------
.PHONY: create
create:
	@if aws cloudformation describe-stacks --stack-name $(LAMBDA_UPLOAD_STACK) &> /dev/null; then \
		echo "Lambda upload stack already exists--did you mean to run make deploy?" ;\
		exit 2 ;\
	fi
# Create the bucket (version-enabled) to upload lambda functions to.
	@echo "Creating bucket for lambda Zip files..."
	@aws cloudformation deploy --stack-name $(LAMBDA_UPLOAD_STACK)                          \
		--template-file $(LAMBDA_UPLOAD_CFN)                                               \
		--parameter-overrides Unique=$(UNIQUE)  
	@if aws cloudformation describe-stacks --stack-name $(OFFLINE_STACK) &> /dev/null; then \
		echo "Offline processing stack already exists--did you mean to run make deploy?" ;\
		exit 2 ;\
	fi
# Create initial Zip file with all lambdas (because neither should exist at this point)
	@make -C lambda
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

# --- Update parts of the previously created stack -- used after initial create -------------
#     Really should depend on BOTH CFN_FILE and any modified lambdas
#     Implementing this is probably kludgy in make.
.PHONY: update
update:
# Monster hack. Touch the CFN file (even if it's already been modified)
# to make DAMN sure that the cloudformation deploy happens. Need to
# figure out how to get make to do this without this hack.
	@touch $(CFN_FILE)
# Always update the lambda Zip file and upload to S3
	@make -C lambda
# TODO: if CFN_FILE updated (newer than what?)
	@set -e ;\
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
# TODO: else must want to back door modified lambda code

# --- Delete stack and all its resources ----------------------------------------------------
.PHONY: delete
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
	@rm lambda/lambda.zip
	@rm -rf lambda/node_modules
	@rm lambda/package-lock.json
	@if ! aws cloudformation describe-stacks --stack-name $(OFFLINE_STACK) &> /dev/null; then \
		echo "Offline processing stack does not exist--can not delete it!" ;\
		exit 2 ;\
	fi
	@aws s3 rm s3://$(OFFLINE_RESULTS_BUCKET) --recursive
	@aws s3 rm s3://$(OFFLINE_UPLOADS_BUCKET) --recursive
	@aws cloudformation delete-stack --stack-name $(OFFLINE_STACK)
# TODO: add cloudformation describe-stack-resources to show what resorces must be
# deleted by hand.

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
