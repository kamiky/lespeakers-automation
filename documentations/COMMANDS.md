yarn scrape:event-agencies:step0 --country=fr --prod --city=rouen
yarn scrape:event-agencies:step1 --country=fr --prod --city=rouen
yarn scrape:event-agencies:step2 --country=fr --prod --city=rouen
yarn scrape:event-agencies:step3 --country=fr --prod --city=rouen

yarn outreach:linkedin --country=fr --city=rouen --prod

yarn brevo:send:template --template=52 --email=dieye.houraye@gmail.com

yarn scrape:event-agencies:step1 --debug-url=https://www.agence-evenementielle-innovevents.fr/reseau-evenementiel/paris/

yarn scrape:event-agencies:step3
