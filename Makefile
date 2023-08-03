# This Makefile is probably overly complex and error prone. But, it
# does make developer life easier.
# FIXME: Investigate SAM CLI or scripting to replace use of make.
SHELL := /bin/bash
.SHELLFLAGS := -c

UNIQUE := losalamosal
OFFLINE_STACK := $(UNIQUE)--bookfinder-offline
CFN_FILE := build-book-db.yml

# Bucket must exist and have versioning enabled
export LAMBDA_UPLOAD_BUCKET := $(UNIQUE)--lambda-uploads
LAMBDA_UPLOAD_STACK := $(UNIQUE)--lambda-upload
LAMBDA_UPLOAD_CFN := lambda-bucket.yml

OFFLINE_UPLOADS_BUCKET := $(UNIQUE)--bookfinder-uploads
OFFLINE_RESULTS_BUCKET := $(UNIQUE)--bookfinder-results

# --- Default target will be run when no target specified. -----------------------------------
.PHONY: error
error:
	@echo "Please choose one of the following targets: create, read, update, delete"
	@echo "For more info see README.md in the GitHub repo"
	@exit 2

# --- Create everything from scratch -- must be called first --------------------------------
.PHONY: create
create:
	@if aws cloudformation describe-stacks --stack-name $(LAMBDA_UPLOAD_STACK) &> /dev/null; then	\
		echo "Lambda upload stack already exists--did you mean to run make update?" ;				\
		exit 2 ;																					\
	fi
# Create the bucket (version-enabled) to upload lambda functions to.
	@echo "Creating bucket for lambda Zip files..."
	@aws cloudformation deploy --stack-name $(LAMBDA_UPLOAD_STACK)                          		\
		--template-file $(LAMBDA_UPLOAD_CFN)                                               			\
		--parameter-overrides Unique=$(UNIQUE)  
	@if aws cloudformation describe-stacks --stack-name $(OFFLINE_STACK) &> /dev/null; then 		\
		echo "Offline processing stack already exists--did you mean to run make deploy?" ;			\
		exit 2 ;																					\
	fi
# Create initial Zip file with all lambdas (because neither should exist at this point)
	@$(MAKE) -C lambda
	@set -e    ;																					\
	zip_version=$$(aws s3api list-object-versions                                					\
		--bucket $(LAMBDA_UPLOAD_BUCKET) --prefix lambda.zip                             			\
		--query 'Versions[?IsLatest == `true`].VersionId | [0]'                   					\
		--output text)                                                           ;					\
	echo "Running aws cloudformation deploy with ZIP version $$zip_version..."   ;					\
	aws cloudformation deploy --stack-name $(OFFLINE_STACK)                          				\
		--template-file $(CFN_FILE)                                               					\
		--parameter-overrides     																	\
			ZipVersionId=$$zip_version                          									\
			ZipBucketName=$(LAMBDA_UPLOAD_BUCKET)           										\
			Unique=$(UNIQUE)    																	\
		--capabilities CAPABILITY_NAMED_IAM

.PHONY: read
read:
	@aws cloudformation describe-stacks --stack-name $(OFFLINE_STACK)

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
	@set -e ;																						\
	zip_version=$$(aws s3api list-object-versions                                 					\
		--bucket $(LAMBDA_UPLOAD_BUCKET) --prefix lambda.zip                             			\
		--query 'Versions[?IsLatest == `true`].VersionId | [0]'                   					\
		--output text)                                                           ;					\
	echo "Running aws cloudformation deploy with ZIP version $$zip_version..."   ;					\
	aws cloudformation deploy --stack-name $(OFFLINE_STACK)                          				\
		--template-file $(CFN_FILE)                                               					\
		--parameter-overrides     																	\
			ZipVersionId=$$zip_version                          									\
			ZipBucketName=$(LAMBDA_UPLOAD_BUCKET)           										\
			Unique=$(UNIQUE)    																	\
		--capabilities CAPABILITY_NAMED_IAM
# TODO: else must want to back door modified lambda code

# --- Delete stack and all its resources ----------------------------------------------------
.PHONY: delete
delete:
	@if ! aws cloudformation describe-stacks --stack-name $(LAMBDA_UPLOAD_STACK) &> /dev/null; then \
		echo "Lambda upload stack does not exist--can not delete it!" ;								\
		exit 2 ;																					\
	fi
# Might get error is no objects or delete markers. `-` at beginning
# of line tells make to soldier on in the presence of errors here.
# Thanks https://stackoverflow.com/a/61123579/227441
	@-aws s3api delete-objects --bucket $(LAMBDA_UPLOAD_BUCKET) 									\
		--delete "$$(aws s3api list-object-versions --bucket $(LAMBDA_UPLOAD_BUCKET) 				\
		--query='{Objects: DeleteMarkers[].{Key:Key,VersionId:VersionId}}')"
	@-aws s3api delete-objects --bucket $(LAMBDA_UPLOAD_BUCKET) 									\
		--delete "$$(aws s3api list-object-versions --bucket $(LAMBDA_UPLOAD_BUCKET) 				\
		--query='{Objects: Versions[].{Key:Key,VersionId:VersionId}}')"
	@aws cloudformation delete-stack --stack-name $(LAMBDA_UPLOAD_STACK)
	@rm lambda/lambda.zip
	@rm -rf lambda/node_modules
	@rm lambda/package-lock.json
	@if ! aws cloudformation describe-stacks --stack-name $(OFFLINE_STACK) &> /dev/null; then 		\
		echo "Offline processing stack does not exist--can not delete it!" ;						\
		exit 2 ;																					\
	fi
	@aws s3 rm s3://$(OFFLINE_RESULTS_BUCKET) --recursive
	@aws s3 rm s3://$(OFFLINE_UPLOADS_BUCKET) --recursive
	@aws cloudformation delete-stack --stack-name $(OFFLINE_STACK)
# Delete leftover log groups
	@set -e ; 																						\
	groups=$$(aws logs describe-log-groups --query 'logGroups[].logGroupName' --output text) ; 		\
	for g in $$groups ; do 																			\
		aws logs delete-log-group --log-group-name $$g ; 											\
	done

# When this Makefile gets cleaned up, let this section dump anything
# that might be useful (files produced, certificate ARN, API endpoint,
# API d- version of the endpoint), etc.
.PHONY: list
list:
	@echo "Bucket: $(OFFLINE_RESULTS_BUCKET)"
	@aws s3 ls s3://$(OFFLINE_RESULTS_BUCKET) --recursive
	@echo "Bucket: $(OFFLINE_UPLOADS_BUCKET)"
	@aws s3 ls s3://$(OFFLINE_UPLOADS_BUCKET) --recursive
	@set -e;																						\
	table_name=$$(aws dynamodb list-tables --query 'TableNames[0]' --output text);					\
	aws dynamodb scan --table-name $$table_name --select COUNT;										\
	aws dynamodb describe-table --table-name $$table_name
