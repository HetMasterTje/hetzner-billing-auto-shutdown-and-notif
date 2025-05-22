FROM node:20.19.1

WORKDIR /app

copy package*json ./
RUN npm install

copy . .

# expose 3000

CMD ["npm", "start"]