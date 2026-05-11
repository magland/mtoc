% Complex tensor returns. Same machinery, complex-aware codegen.

function z = times2i(w)
  z = w .* 2i;
end

function z = conj_sq(w)
  c = conj(w);
  z = w .* c;
end

w = [1+2i 3-4i 0+1i];
z1 = times2i(w);
disp(z1);

z2 = conj_sq(w);
disp(z2);

% Column vector
cw = [1+1i; 2+0i; 0-3i];
cz = times2i(cw);
disp(cz);
