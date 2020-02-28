FROM node:8.7

# Setting working directory. All the path will be relative to WORKDIR
WORKDIR /usr/src/app

# Installing dependencies
COPY package*.json ./
COPY yarn.lock ./
RUN yarn

# Copying source files
COPY . .

EXPOSE 4000

# Running the app
CMD [ "yarn", "start" ]
