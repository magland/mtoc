% Splitting also applies inside a function body's top level.
function r = mix(x)
  r = x + 1;
  disp(r);
  r = [r r r];
  disp(r);
  r = sum(r);
end

disp(mix(2));
