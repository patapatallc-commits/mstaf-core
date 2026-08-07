WATCH & BUY AI FIELD-MAPPING FIX

Problem:
The AI handler correctly fills:
  watchBuySpecifications

But it also fills:
  watchBuyNotes

The watchBuyNotes field is your:
  Seller/store name, shipping, return policy, buy link or additional product details

That is why AI specifications are appearing in the wrong seller/store field.

FIX

In server.js, find this block inside the Watch & Buy AI success handler:

      const item=byId('watchBuyItemName');
      const specs=byId('watchBuySpecifications');
      const notes=byId('watchBuyNotes');
      if(item&&!text(item.value)&&details.productNameSuggestion)item.value=details.productNameSuggestion;
      if(specs)specs.value=text(details.shortSpecification).slice(0,220);
      if(notes){
        const features=Array.isArray(details.visibleFeatures)?details.visibleFeatures.join(', '):'';
        const confirms=Array.isArray(details.sellerConfirmationRequired)?details.sellerConfirmationRequired.join(', '):'';
        notes.value=[details.category?('Category: '+details.category):'',features?('Visible features: '+features):'',confirms?('Seller must confirm: '+confirms):'',details.socialCaption?('Social caption: '+details.socialCaption):'',Array.isArray(details.hashtags)&&details.hashtags.length?('Hashtags: '+details.hashtags.join(' ')):''].filter(Boolean).join('\n').slice(0,1800);
      }

Replace it with this:

      const item=byId('watchBuyItemName');
      const specs=byId('watchBuySpecifications');

      if(item&&!text(item.value)&&details.productNameSuggestion){
        item.value=details.productNameSuggestion;
      }

      if(specs){
        const features=Array.isArray(details.visibleFeatures)
          ? details.visibleFeatures.join(', ')
          : '';

        const confirmation=Array.isArray(details.sellerConfirmationRequired)
          ? details.sellerConfirmationRequired.join(', ')
          : '';

        specs.value=[
          text(details.shortSpecification),
          features ? ('Visible features: '+features) : '',
          confirmation ? ('Seller confirmation required: '+confirmation) : ''
        ].filter(Boolean).join('\n').slice(0,220);
      }

IMPORTANT:
Do not set watchBuyNotes automatically.
That field should remain for the seller to manually enter:
- Store name
- Shipping information
- Return policy
- Additional product details
- Buy instructions

Also search for any second AI handler containing:

      const notes=document.getElementById('watchBuyNotes');

Remove its notes-filling block too, so only watchBuySpecifications receives AI-generated details.
