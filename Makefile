GIT_REV := $(shell git rev-parse --short HEAD)
default: nodejs nginx

nodejs:
	docker build --no-cache -f Dockerfile-nodejs -t gcr.io/eyeballr-beta/nodejs:$(GIT_REV) .

nginx:
	docker build --no-cache -f Dockerfile-nginx -t gcr.io/eyeballr-beta/nginx:$(GIT_REV) .
