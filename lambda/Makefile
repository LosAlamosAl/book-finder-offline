SHELL := /bin/bash
.SHELLFLAGS := -c

all: node_modules lambda.zip

node_modules: package.json
	@npm install

# ?*    modified dependencies
# ?^    all dependencies
lambda.zip: *.js
#	@echo sub: $(SHELL)
#	@echo sub: $(.SHELLFLAGS)
#	@echo sub: $(MAKEFLAGS)
#	@echo $(filter HACK%, $(MAKEFLAGS))
#	@echo $(HACK)
#	@echo sub: $(LAMBDA_UPLOAD_BUCKET)
	@echo "zipping and uploading... node_modules" $^
	@zip -FS -r -q lambda.zip node_modules $^
	@aws s3 cp lambda.zip s3://$(LAMBDA_UPLOAD_BUCKET)
	@for FILE in $? ;\
	do \
		echo ...lambda code was modifier: $$FILE ;\
	done
